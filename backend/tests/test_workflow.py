from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app
from app.models import CampusLocation, MaintenanceCategory, User
from app.security import hash_password


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, tmp_path) -> Generator[TestClient, None, None]:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSession = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    from app.config import settings
    monkeypatch.setattr(settings, "upload_dir", tmp_path / "uploads")

    def override_db():
        db = TestingSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_db
    with TestingSession() as db:
        db.add_all([
            User(name="Campus Coordinator", email="coordinator@example.edu", password_hash=hash_password("Coordinator-pass-123"), role="coordinator"),
            User(name="Campus Technician", email="technician@example.edu", password_hash=hash_password("Technician-pass-123"), role="technician"),
            User(name="Campus Administrator", email="admin@example.edu", password_hash=hash_password("Administrator-pass-123"), role="administrator"),
        ])
        db.add_all(MaintenanceCategory(name=name) for name in (
            "Electrical", "Plumbing", "Furniture", "Computer / IT equipment",
            "Classroom facilities", "Building maintenance", "Other",
        ))
        db.add_all(CampusLocation(name=name) for name in (
            "Science Hall", "North Hall", "Engineering Hall", "Library",
            "West Hall", "Arts Building",
        ))
        db.commit()
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
    Base.metadata.drop_all(engine)
    engine.dispose()


def login(client: TestClient, email: str, password: str) -> str:
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200
    return response.json()["access_token"]


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def register_requester(client: TestClient, email: str = "student@example.edu") -> tuple[str, int]:
    response = client.post("/api/auth/register", json={
        "name": "Student Requester",
        "email": email,
        "password": "Requester-pass-123",
    })
    assert response.status_code == 201
    return response.json()["access_token"], response.json()["user"]["id"]


def test_complete_work_order_flow_and_duplicate_request_retry(client: TestClient):
    requester_token, _ = register_requester(client)
    payload = {
        "title": "Projector will not power on",
        "description": "Classroom projector does not power on after testing its cable.",
        "category": "Computer / IT equipment",
        "building": "Science Hall",
        "room": "204",
    }
    key = "stable-client-operation-001"
    first = client.post("/api/requests", json=payload, headers={**auth(requester_token), "Idempotency-Key": key})
    retry = client.post("/api/requests", json=payload, headers={**auth(requester_token), "Idempotency-Key": key})
    assert first.status_code == 201
    assert retry.status_code == 201
    assert retry.json()["public_id"] == first.json()["public_id"]

    coordinator_token = login(client, "coordinator@example.edu", "Coordinator-pass-123")
    technician_token = login(client, "technician@example.edu", "Technician-pass-123")
    administrator_token = login(client, "admin@example.edu", "Administrator-pass-123")

    denied = client.post(
        f"/api/requests/{first.json()['id']}/review",
        json={"decision": "reject", "expected_version": 1},
        headers=auth(requester_token),
    )
    assert denied.status_code == 403

    assigned = client.post(
        f"/api/requests/{first.json()['id']}/review",
        json={
            "decision": "approve",
            "priority": "High",
            "technician_id": 2,
            "remarks": "Assigned to the equipment team.",
            "expected_version": 1,
        },
        headers=auth(coordinator_token),
    )
    assert assigned.status_code == 200, assigned.text
    assert assigned.json()["status"] == "Assigned"
    order = client.get("/api/work-orders", headers=auth(technician_token)).json()[0]

    accepted = client.post(
        f"/api/work-orders/{order['id']}/accept",
        json={"expected_version": order["version"]},
        headers=auth(technician_token),
    )
    assert accepted.status_code == 200
    assert accepted.json()["status"] == "In Progress"

    progress = client.post(
        f"/api/work-orders/{order['id']}/updates",
        json={"note": "Replaced the power adapter and confirmed the projector boots.", "submit_for_verification": True},
        headers=auth(technician_token),
    )
    assert progress.status_code == 200, progress.text
    assert progress.json()["status"] == "For Verification"

    complete = client.post(
        f"/api/work-orders/{order['id']}/verify",
        json={"verified": True, "remarks": "Projector tested and operating correctly.", "expected_version": 3},
        headers=auth(administrator_token),
    )
    assert complete.status_code == 200, complete.text
    assert complete.json()["status"] == "Completed"
    requester_view = client.get("/api/requests", headers=auth(requester_token))
    assert requester_view.json()[0]["status"] == "Completed"


def test_role_scope_and_invalid_transitions_are_rejected(client: TestClient):
    requester_token, _ = register_requester(client)
    response = client.post("/api/requests", json={
        "title": "Broken classroom light",
        "description": "Ceiling light flickers and then goes completely dark.",
        "category": "Electrical",
        "building": "North Hall",
        "room": "16",
    }, headers=auth(requester_token))
    assert response.status_code == 201

    technician_token = login(client, "technician@example.edu", "Technician-pass-123")
    assert client.get("/api/requests", headers=auth(technician_token)).json() == []
    assert client.get("/api/users", headers=auth(technician_token)).status_code == 403

    coordinator_token = login(client, "coordinator@example.edu", "Coordinator-pass-123")
    bad_decision = client.post(
        f"/api/requests/{response.json()['id']}/review",
        json={"decision": "approve", "expected_version": 99, "technician_id": 2},
        headers=auth(coordinator_token),
    )
    assert bad_decision.status_code == 409
    rejected = client.post(
        f"/api/requests/{response.json()['id']}/review",
        json={"decision": "reject", "expected_version": 1, "remarks": "Insufficient location details."},
        headers=auth(coordinator_token),
    )
    assert rejected.status_code == 200
    assert rejected.json()["status"] == "Rejected"


def test_catalog_is_admin_managed_and_inactive_values_cannot_be_submitted(client: TestClient):
    admin_token = login(client, "admin@example.edu", "Administrator-pass-123")
    requester_token, _ = register_requester(client)

    created_category = client.post(
        "/api/catalog/categories",
        json={"name": "Roofing"},
        headers=auth(admin_token),
    )
    created_location = client.post(
        "/api/catalog/locations",
        json={"name": "West Annex"},
        headers=auth(admin_token),
    )
    assert created_category.status_code == 201
    assert created_location.status_code == 201
    assert "Roofing" in [item["name"] for item in client.get(
        "/api/catalog", headers=auth(requester_token)
    ).json()["categories"]]
    assert "West Annex" in [item["name"] for item in client.get(
        "/api/catalog", headers=auth(requester_token)
    ).json()["locations"]]
    assert client.post(
        "/api/catalog/categories",
        json={"name": " roofing "},
        headers=auth(admin_token),
    ).status_code == 409

    deactivated = client.patch(
        f"/api/catalog/categories/{created_category.json()['id']}",
        json={"is_active": False},
        headers=auth(admin_token),
    )
    assert deactivated.status_code == 200
    invalid_category = client.post("/api/requests", json={
        "title": "Roof damage",
        "description": "Water enters the classroom through a damaged section of roofing.",
        "category": "Roofing",
        "building": "West Annex",
        "room": "2",
    }, headers=auth(requester_token))
    assert invalid_category.status_code == 422

    client.patch(
        f"/api/catalog/locations/{created_location.json()['id']}",
        json={"is_active": False},
        headers=auth(admin_token),
    )
    invalid_location = client.post("/api/requests", json={
        "title": "Electrical fault",
        "description": "An outlet sparks when a device is plugged in.",
        "category": "Electrical",
        "building": "West Annex",
        "room": "3",
    }, headers=auth(requester_token))
    assert invalid_location.status_code == 422


def test_websocket_delivers_committed_role_notifications(client: TestClient):
    requester_token, _ = register_requester(client)
    coordinator_token = login(client, "coordinator@example.edu", "Coordinator-pass-123")
    with client.websocket_connect(f"/api/ws?token={coordinator_token}") as websocket:
        response = client.post("/api/requests", json={
            "title": "Leaking sink in lab",
            "description": "The sink under the counter is leaking onto the floor.",
            "category": "Plumbing",
            "building": "Engineering Hall",
            "room": "10",
        }, headers=auth(requester_token))
        assert response.status_code == 201
        event = websocket.receive_json()
        assert event["type"] == "notification"
        assert response.json()["public_id"] in event["message"]


def test_request_photos_are_persisted_and_access_checked(client: TestClient):
    requester_token, _ = register_requester(client)
    request = client.post("/api/requests", json={
        "title": "Damaged classroom chair",
        "description": "The chair frame is loose and the back support is detached.",
        "category": "Furniture",
        "building": "Library",
        "room": "2",
    }, headers=auth(requester_token)).json()
    image = b"\x89PNG\r\n\x1a\n" + b"test-image-bytes"
    uploaded = client.post(
        f"/api/requests/{request['id']}/attachments",
        headers=auth(requester_token),
        files={"file": ("chair.png", image, "image/png")},
    )
    assert uploaded.status_code == 201, uploaded.text
    attachment_id = uploaded.json()["public_id"]

    requester_file = client.get(f"/api/attachments/{attachment_id}", headers=auth(requester_token))
    assert requester_file.status_code == 200
    assert requester_file.content == image

    other_token, _ = register_requester(client, "other-student@example.edu")
    denied = client.get(f"/api/attachments/{attachment_id}", headers=auth(other_token))
    assert denied.status_code == 404

    rejected = client.post(
        f"/api/requests/{request['id']}/attachments",
        headers=auth(requester_token),
        files={"file": ("fake.txt", b"not an image", "text/plain")},
    )
    assert rejected.status_code == 415

    coordinator_token = login(client, "coordinator@example.edu", "Coordinator-pass-123")
    assigned = client.post(f"/api/requests/{request['id']}/review", json={
        "decision": "approve", "technician_id": 2, "expected_version": 1,
    }, headers=auth(coordinator_token))
    assert assigned.status_code == 200
    technician_token = login(client, "technician@example.edu", "Technician-pass-123")
    technician_file = client.get(f"/api/attachments/{attachment_id}", headers=auth(technician_token))
    assert technician_file.status_code == 200


def test_assignment_retry_reassignment_and_transition_guard(client: TestClient):
    requester_token, _ = register_requester(client)
    submitted = client.post("/api/requests", json={
        "title": "Damaged water fountain",
        "description": "The water fountain button is stuck and water will not stop running.",
        "category": "Plumbing",
        "building": "West Hall",
        "room": "Ground floor",
    }, headers=auth(requester_token)).json()
    coordinator_token = login(client, "coordinator@example.edu", "Coordinator-pass-123")
    admin_token = login(client, "admin@example.edu", "Administrator-pass-123")
    new_technician = client.post("/api/users", json={
        "name": "Second Technician",
        "email": "second-tech@example.edu",
        "password": "Second-tech-pass-123",
        "role": "technician",
    }, headers=auth(admin_token))
    assert new_technician.status_code == 201

    approval = client.post(f"/api/requests/{submitted['id']}/review", json={
        "decision": "approve", "technician_id": 2, "expected_version": 1,
    }, headers=auth(coordinator_token))
    assert approval.status_code == 200
    duplicate_approval = client.post(f"/api/requests/{submitted['id']}/review", json={
        "decision": "approve", "technician_id": 2, "expected_version": 1,
    }, headers=auth(coordinator_token))
    assert duplicate_approval.status_code == 409

    order_id = client.get("/api/work-orders", headers=auth(coordinator_token)).json()[0]["id"]
    reassigned = client.post(f"/api/work-orders/{order_id}/reassign", json={
        "technician_id": new_technician.json()["id"], "expected_version": 1,
    }, headers=auth(coordinator_token))
    assert reassigned.status_code == 200
    assert reassigned.json()["status"] == "Assigned"
    assert len(client.get("/api/work-orders", headers=auth(login(client, "technician@example.edu", "Technician-pass-123"))).json()) == 0
    new_tech_token = login(client, "second-tech@example.edu", "Second-tech-pass-123")
    assert len(client.get("/api/work-orders", headers=auth(new_tech_token)).json()) == 1

    invalid_verify = client.post(f"/api/work-orders/{order_id}/verify", json={
        "verified": True, "remarks": "Cannot complete an assigned job.", "expected_version": 2,
    }, headers=auth(admin_token))
    assert invalid_verify.status_code == 409


def test_role_notification_read_state_and_station_heartbeat(client: TestClient):
    admin_token = login(client, "admin@example.edu", "Administrator-pass-123")
    second_coordinator = client.post("/api/users", json={
        "name": "Second Coordinator",
        "email": "second-coordinator@example.edu",
        "password": "Second-coordinator-pass-123",
        "role": "coordinator",
    }, headers=auth(admin_token))
    assert second_coordinator.status_code == 201
    requester_token, _ = register_requester(client)
    response = client.post("/api/requests", json={
        "title": "Loose classroom desk",
        "description": "The desk legs are loose and the desk rocks when students use it.",
        "category": "Furniture",
        "building": "Arts Building",
        "room": "12",
    }, headers=auth(requester_token))
    assert response.status_code == 201

    coordinator_token = login(client, "coordinator@example.edu", "Coordinator-pass-123")
    second_token = login(client, "second-coordinator@example.edu", "Second-coordinator-pass-123")
    first_notifications = client.get("/api/notifications", headers=auth(coordinator_token)).json()
    second_notifications = client.get("/api/notifications", headers=auth(second_token)).json()
    first_entry = next(item for item in first_notifications if item["entity_id"] == response.json()["public_id"])
    second_entry = next(item for item in second_notifications if item["id"] == first_entry["id"])
    assert first_entry["read_at"] is None and second_entry["read_at"] is None

    marked = client.post(f"/api/notifications/{first_entry['id']}/read", headers=auth(coordinator_token))
    assert marked.status_code == 204
    first_after = client.get("/api/notifications", headers=auth(coordinator_token)).json()
    second_after = client.get("/api/notifications", headers=auth(second_token)).json()
    assert next(item for item in first_after if item["id"] == first_entry["id"])["read_at"] is not None
    assert next(item for item in second_after if item["id"] == first_entry["id"])["read_at"] is None

    heartbeat = client.post("/api/stations/heartbeat", json={"station_id": "requester-laptop-1"}, headers=auth(requester_token))
    assert heartbeat.status_code == 204
    stations = client.get("/api/stations", headers=auth(admin_token))
    assert stations.status_code == 200
    assert stations.json()[0]["connected"] is True

    deactivated = client.patch(
        f"/api/users/{second_coordinator.json()['id']}/status",
        json={"is_active": False},
        headers=auth(admin_token),
    )
    assert deactivated.status_code == 200
    assert client.get("/api/auth/me", headers=auth(second_token)).status_code == 401
