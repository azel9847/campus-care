import csv
import io
import secrets
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, File, Header, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, StreamingResponse
from jose import JWTError, jwt
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, joinedload
from starlette import status

from app.config import settings
from app.database import get_db
from app.models import (
    ActivityLog,
    Attachment,
    CampusLocation,
    MaintenanceCategory,
    MaintenanceRequest,
    Notification,
    NotificationReceipt,
    RepairUpdate,
    StationRegistry,
    User,
    WorkOrder,
)
from app.realtime import manager
from app.schemas import (
    LoginIn,
    AttachmentOut,
    CatalogActiveIn,
    CatalogCreateIn,
    NotificationOut,
    RegisterIn,
    ReassignIn,
    RequestCreateIn,
    RequestOut,
    RequestReviewIn,
    StationHeartbeatIn,
    TokenOut,
    UserActiveIn,
    UserCreateIn,
    UserOut,
    VerificationIn,
    WorkOrderOut,
    WorkAcceptIn,
    WorkUpdateIn,
)
from app.security import create_access_token, decode_access_token, hash_password, verify_password

router = APIRouter()
CATEGORIES = [
    "Electrical",
    "Plumbing",
    "Furniture",
    "Computer / IT equipment",
    "Classroom facilities",
    "Building maintenance",
    "Other",
]
INITIAL_LOCATIONS = ["Main Campus", "Other"]


def current_user(authorization: str | None = Header(default=None), db: Session = Depends(get_db)) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Authentication required.")
    try:
        user_id = decode_access_token(authorization[7:])
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Account is unavailable.")
    return user


def require_roles(*roles: str):
    def dependency(user: User = Depends(current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=403, detail="Your account is not permitted to perform this action.")
        return user
    return dependency


def add_log(db: Session, actor: User, action: str, entity_type: str, entity_id: str, details: str = "") -> None:
    db.add(ActivityLog(actor_id=actor.id, action=action, entity_type=entity_type, entity_id=entity_id, details=details))


def add_notification(
    db: Session,
    title: str,
    message: str,
    entity_type: str,
    entity_id: str,
    *,
    roles: tuple[str, ...] = (),
    users: tuple[int, ...] = (),
) -> tuple[set[str], set[int], dict]:
    for role in set(roles):
        db.add(Notification(target_role=role, title=title, message=message, entity_type=entity_type, entity_id=entity_id))
    for user_id in set(users):
        db.add(Notification(user_id=user_id, title=title, message=message, entity_type=entity_type, entity_id=entity_id))
    event = {
        "type": "notification",
        "title": title,
        "message": message,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    return set(roles), set(users), event


def publish_after_commit(background: BackgroundTasks, audience: tuple[set[str], set[int], dict]) -> None:
    roles, user_ids, event = audience
    background.add_task(manager.publish, roles, user_ids, event)


def request_out(request: MaintenanceRequest) -> RequestOut:
    return RequestOut(
        id=request.id,
        public_id=request.public_id,
        requester_id=request.requester_id,
        requester_name=request.requester.name,
        requester_email=request.requester.email,
        title=request.title,
        description=request.description,
        category=request.category,
        building=request.building,
        room=request.room,
        status=request.status,
        priority=request.priority,
        review_remarks=request.review_remarks,
        version=request.version,
        created_at=request.created_at,
        updated_at=request.updated_at,
        work_order_id=request.work_order.public_id if request.work_order else None,
        technician_name=request.work_order.technician.name if request.work_order else None,
        attachments=[AttachmentOut.model_validate(item) for item in request.attachments],
    )


def work_order_out(order: WorkOrder) -> WorkOrderOut:
    request = order.request
    return WorkOrderOut(
        id=order.id,
        public_id=order.public_id,
        request_id=request.public_id,
        title=request.title,
        description=request.description,
        category=request.category,
        building=request.building,
        room=request.room,
        priority=request.priority,
        requester_name=request.requester.name,
        technician_id=order.technician_id,
        technician_name=order.technician.name,
        status=order.status,
        assigned_at=order.assigned_at,
        updated_at=order.updated_at,
        completed_at=order.completed_at,
        version=order.version,
        updates=[
            {
                "id": update.id,
                "note": update.note,
                "author_name": update.author.name,
                "created_at": update.created_at,
            }
            for update in order.updates
        ],
        attachments=[AttachmentOut.model_validate(item) for item in [*order.attachments, *request.attachments]],
    )


IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
MAX_IMAGE_BYTES = 5 * 1024 * 1024


async def store_attachment(
    file: UploadFile,
    actor: User,
    db: Session,
    *,
    request: MaintenanceRequest | None = None,
    order: WorkOrder | None = None,
) -> Attachment:
    content_type = file.content_type or ""
    if content_type not in IMAGE_TYPES:
        raise HTTPException(status_code=415, detail="Only JPEG, PNG, and WebP images are supported.")
    content = await file.read(MAX_IMAGE_BYTES + 1)
    if not content or len(content) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image must be between 1 byte and 5 MB.")
    valid_signature = (
        (content_type == "image/jpeg" and content.startswith(b"\xff\xd8\xff"))
        or (content_type == "image/png" and content.startswith(b"\x89PNG\r\n\x1a\n"))
        or (content_type == "image/webp" and content.startswith(b"RIFF") and content[8:12] == b"WEBP")
    )
    if not valid_signature:
        raise HTTPException(status_code=415, detail="The uploaded file does not match its image type.")
    public_id = secrets.token_hex(16)
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    destination = settings.upload_dir / f"{public_id}{IMAGE_TYPES[content_type]}"
    destination.write_bytes(content)
    attachment = Attachment(
        public_id=public_id,
        request_id=request.id if request else None,
        work_order_id=order.id if order else None,
        uploader_id=actor.id,
        filename=Path(file.filename or "maintenance-image").name[:255],
        content_type=content_type,
        file_path=str(destination.resolve()),
    )
    db.add(attachment)
    try:
        db.commit()
        db.refresh(attachment)
    except SQLAlchemyError:
        db.rollback()
        destination.unlink(missing_ok=True)
        raise
    return attachment


@router.post("/auth/register", response_model=TokenOut, status_code=201)
def register(payload: RegisterIn, db: Session = Depends(get_db)):
    email = payload.email.strip().lower()
    if "@" not in email:
        raise HTTPException(status_code=422, detail="Enter a valid email address.")
    if db.scalar(select(User.id).where(User.email == email)):
        raise HTTPException(status_code=409, detail="An account with this email already exists.")
    user = User(name=payload.name.strip(), email=email, password_hash=hash_password(payload.password), role="requester")
    db.add(user)
    db.commit()
    db.refresh(user)
    return TokenOut(access_token=create_access_token(user.id), user=user)


@router.post("/auth/login", response_model=TokenOut)
def login(payload: LoginIn, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == payload.email.strip().lower()))
    if not user or not user.is_active or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Email or password is incorrect.")
    return TokenOut(access_token=create_access_token(user.id), user=user)


@router.get("/auth/me", response_model=UserOut)
def me(user: User = Depends(current_user)):
    return user


@router.patch("/auth/profile", response_model=UserOut)
def update_profile(name: str = Query(min_length=2, max_length=120), user: User = Depends(current_user), db: Session = Depends(get_db)):
    user.name = name.strip()
    add_log(db, user, "profile.updated", "user", str(user.id))
    db.commit()
    db.refresh(user)
    return user


@router.get("/users", response_model=list[UserOut])
def list_users(
    role: str | None = Query(default=None),
    actor: User = Depends(require_roles("coordinator", "administrator")),
    db: Session = Depends(get_db),
):
    query = select(User)
    if actor.role != "administrator":
        if role not in (None, "technician"):
            raise HTTPException(status_code=403, detail="Coordinators may only view technician accounts.")
        query = query.where(User.is_active.is_(True), User.role == "technician")
    if role:
        query = query.where(User.role == role)
    return db.scalars(query.order_by(User.name)).all()


@router.post("/users", response_model=UserOut, status_code=201)
def create_user(payload: UserCreateIn, actor: User = Depends(require_roles("administrator")), db: Session = Depends(get_db)):
    email = payload.email.strip().lower()
    if "@" not in email:
        raise HTTPException(status_code=422, detail="Enter a valid email address.")
    user = User(name=payload.name.strip(), email=email, password_hash=hash_password(payload.password), role=payload.role)
    db.add(user)
    try:
        db.flush()
        add_log(db, actor, "user.created", "user", str(user.id), f"Role: {user.role}")
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="An account with this email already exists.") from exc
    db.refresh(user)
    return user


@router.patch("/users/{user_id}/status", response_model=UserOut)
def set_user_status(
    user_id: int,
    payload: UserActiveIn,
    background: BackgroundTasks,
    actor: User = Depends(require_roles("administrator")),
    db: Session = Depends(get_db),
):
    if user_id == actor.id and not payload.is_active:
        raise HTTPException(status_code=409, detail="You cannot disable your own administrator account.")
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found.")
    target.is_active = payload.is_active
    add_log(db, actor, "user.activated" if payload.is_active else "user.deactivated", "user", str(target.id))
    db.commit()
    db.refresh(target)
    if not payload.is_active:
        background.add_task(manager.disconnect_user, target.id)
    return target


@router.get("/catalog")
def read_catalog(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return {
        "categories": [
            {"id": item.id, "name": item.name, "is_active": item.is_active}
            for item in db.scalars(select(MaintenanceCategory).where(MaintenanceCategory.is_active.is_(True)).order_by(MaintenanceCategory.name)).all()
        ],
        "locations": [
            {"id": item.id, "name": item.name, "is_active": item.is_active}
            for item in db.scalars(select(CampusLocation).where(CampusLocation.is_active.is_(True)).order_by(CampusLocation.name)).all()
        ],
    }


def catalog_model(kind: str):
    if kind == "categories":
        return MaintenanceCategory
    if kind == "locations":
        return CampusLocation
    raise HTTPException(status_code=404, detail="Catalog type must be categories or locations.")


@router.get("/catalog/{kind}/all")
def read_catalog_admin(kind: str, _: User = Depends(require_roles("administrator")), db: Session = Depends(get_db)):
    model = catalog_model(kind)
    return [
        {"id": item.id, "name": item.name, "is_active": item.is_active}
        for item in db.scalars(select(model).order_by(model.name)).all()
    ]


@router.post("/catalog/{kind}", status_code=201)
def create_catalog_item(
    kind: str,
    payload: CatalogCreateIn,
    actor: User = Depends(require_roles("administrator")),
    db: Session = Depends(get_db),
):
    model = catalog_model(kind)
    name = payload.name.strip()
    if len(name) < 2:
        raise HTTPException(status_code=422, detail="Catalog name must contain at least two non-space characters.")
    if db.scalar(select(model.id).where(func.lower(model.name) == name.lower())):
        raise HTTPException(status_code=409, detail="That catalog value already exists.")
    item = model(name=name)
    db.add(item)
    db.flush()
    add_log(db, actor, f"catalog.{kind}.created", "catalog", str(item.id), name)
    db.commit()
    db.refresh(item)
    return {"id": item.id, "name": item.name, "is_active": item.is_active}


@router.patch("/catalog/{kind}/{item_id}")
def set_catalog_status(
    kind: str,
    item_id: int,
    payload: CatalogActiveIn,
    actor: User = Depends(require_roles("administrator")),
    db: Session = Depends(get_db),
):
    model = catalog_model(kind)
    item = db.get(model, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Catalog item not found.")
    item.is_active = payload.is_active
    add_log(db, actor, f"catalog.{kind}.activated" if payload.is_active else f"catalog.{kind}.deactivated", "catalog", str(item.id), item.name)
    db.commit()
    return {"id": item.id, "name": item.name, "is_active": item.is_active}


@router.get("/requests", response_model=list[RequestOut])
def list_requests(
    status_filter: str | None = Query(default=None, alias="status"),
    category: str | None = None,
    location: str | None = None,
    search: str | None = None,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    query = select(MaintenanceRequest).options(
        joinedload(MaintenanceRequest.requester),
        joinedload(MaintenanceRequest.work_order).joinedload(WorkOrder.technician),
    )
    if user.role == "requester":
        query = query.where(MaintenanceRequest.requester_id == user.id)
    elif user.role == "technician":
        query = query.join(WorkOrder).where(WorkOrder.technician_id == user.id)
    if status_filter:
        query = query.where(MaintenanceRequest.status == status_filter)
    if category:
        query = query.where(MaintenanceRequest.category == category)
    if location:
        query = query.where(MaintenanceRequest.building.ilike(f"%{location}%"))
    if search:
        term = f"%{search.strip()}%"
        query = query.where(or_(MaintenanceRequest.title.ilike(term), MaintenanceRequest.public_id.ilike(term)))
    rows = db.scalars(query.order_by(MaintenanceRequest.created_at.desc())).unique().all()
    return [request_out(row) for row in rows]


@router.post("/requests", response_model=RequestOut, status_code=201)
def create_request(
    payload: RequestCreateIn,
    background: BackgroundTasks,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    user: User = Depends(require_roles("requester")),
    db: Session = Depends(get_db),
):
    key = idempotency_key or secrets.token_urlsafe(24)
    if len(key) > 64:
        raise HTTPException(status_code=422, detail="Idempotency-Key must be 64 characters or fewer.")
    category_item = db.scalar(select(MaintenanceCategory).where(
        func.lower(MaintenanceCategory.name) == payload.category.strip().lower(),
        MaintenanceCategory.is_active.is_(True),
    ))
    if not category_item:
        raise HTTPException(status_code=422, detail="Choose an active maintenance category.")
    location_item = db.scalar(select(CampusLocation).where(
        func.lower(CampusLocation.name) == payload.building.strip().lower(),
        CampusLocation.is_active.is_(True),
    ))
    if not location_item:
        raise HTTPException(status_code=422, detail="Choose an active campus location.")
    prior = db.scalar(select(MaintenanceRequest).where(
        MaintenanceRequest.requester_id == user.id, MaintenanceRequest.idempotency_key == key
    ).options(joinedload(MaintenanceRequest.requester), joinedload(MaintenanceRequest.work_order)))
    if prior:
        return request_out(prior)
    request = MaintenanceRequest(
        public_id=f"MR-{secrets.token_hex(4).upper()}",
        requester_id=user.id,
        title=payload.title.strip(),
        description=payload.description.strip(),
        category=category_item.name,
        building=location_item.name,
        room=payload.room.strip(),
        idempotency_key=key,
    )
    db.add(request)
    try:
        db.flush()
        add_log(db, user, "request.created", "request", request.public_id)
        audience = add_notification(
            db, "New maintenance request", f"{request.public_id}: {request.title}",
            "request", request.public_id, roles=("coordinator", "administrator"),
        )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        prior = db.scalar(select(MaintenanceRequest).where(
            MaintenanceRequest.requester_id == user.id, MaintenanceRequest.idempotency_key == key
        ).options(joinedload(MaintenanceRequest.requester)))
        if prior:
            return request_out(prior)
        raise HTTPException(status_code=409, detail="Request could not be saved due to a conflicting update.") from exc
    request = db.scalar(select(MaintenanceRequest).where(MaintenanceRequest.id == request.id).options(joinedload(MaintenanceRequest.requester)))
    publish_after_commit(background, audience)
    return request_out(request)


@router.post("/requests/{request_id}/attachments", response_model=AttachmentOut, status_code=201)
async def upload_request_attachment(
    request_id: int,
    file: UploadFile = File(...),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    request = db.get(MaintenanceRequest, request_id)
    if not request:
        raise HTTPException(status_code=404, detail="Request not found.")
    if user.role == "requester":
        if request.requester_id != user.id or request.status not in ("Pending", "Under Review"):
            raise HTTPException(status_code=403, detail="You may only add a photo to your pending request.")
    elif user.role not in ("coordinator", "administrator"):
        raise HTTPException(status_code=403, detail="Your account cannot add request attachments.")
    return await store_attachment(file, user, db, request=request)


@router.post("/work-orders/{order_id}/attachments", response_model=AttachmentOut, status_code=201)
async def upload_work_order_attachment(
    order_id: int,
    file: UploadFile = File(...),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    order = db.get(WorkOrder, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="Work order not found.")
    if user.role == "technician":
        if order.technician_id != user.id or order.status not in ("Assigned", "In Progress", "Reopened", "For Verification"):
            raise HTTPException(status_code=403, detail="You may only add evidence to your active assignment.")
    elif user.role not in ("coordinator", "administrator"):
        raise HTTPException(status_code=403, detail="Your account cannot add repair attachments.")
    return await store_attachment(file, user, db, order=order)


@router.get("/attachments/{public_id}")
def download_attachment(public_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    attachment = db.scalar(select(Attachment).where(Attachment.public_id == public_id).options(
        joinedload(Attachment.request),
        joinedload(Attachment.work_order),
    ))
    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found.")
    permitted = user.role in ("coordinator", "administrator")
    if attachment.request and attachment.request.requester_id == user.id:
        permitted = True
    if attachment.request and attachment.request.work_order and attachment.request.work_order.technician_id == user.id:
        permitted = True
    if attachment.work_order and attachment.work_order.technician_id == user.id:
        permitted = True
    if not permitted:
        raise HTTPException(status_code=404, detail="Attachment not found.")
    path = Path(attachment.file_path)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Attachment file is unavailable on the server.")
    return FileResponse(path, media_type=attachment.content_type, filename=attachment.filename)


@router.delete("/requests/{request_id}", status_code=204)
def cancel_request(request_id: int, background: BackgroundTasks, user: User = Depends(require_roles("requester")), db: Session = Depends(get_db)):
    request = db.scalar(select(MaintenanceRequest).where(MaintenanceRequest.id == request_id).with_for_update())
    if request is None or request.requester_id != user.id:
        raise HTTPException(status_code=404, detail="Request not found.")
    if request.status != "Pending":
        raise HTTPException(status_code=409, detail="Only pending requests can be cancelled.")
    request.status = "Cancelled"
    request.version += 1
    add_log(db, user, "request.cancelled", "request", request.public_id)
    audience = add_notification(db, "Request cancelled", request.public_id, "request", request.public_id, roles=("coordinator", "administrator"))
    db.commit()
    publish_after_commit(background, audience)


@router.post("/requests/{request_id}/review", response_model=RequestOut)
def review_request(
    request_id: int,
    payload: RequestReviewIn,
    background: BackgroundTasks,
    actor: User = Depends(require_roles("coordinator")),
    db: Session = Depends(get_db),
):
    request = db.scalar(select(MaintenanceRequest).where(MaintenanceRequest.id == request_id).with_for_update())
    if request is None:
        raise HTTPException(status_code=404, detail="Request not found.")
    if request.version != payload.expected_version:
        raise HTTPException(status_code=409, detail="This request changed elsewhere. Refresh and try again.")
    if request.status != "Pending":
        raise HTTPException(status_code=409, detail="Only pending requests can be reviewed.")
    request.priority = payload.priority
    request.review_remarks = payload.remarks.strip()
    request.version += 1
    if payload.decision == "reject":
        request.status = "Rejected"
        title, message = "Request declined", f"{request.public_id}: {request.review_remarks or 'Please contact maintenance for details.'}"
    else:
        if payload.technician_id is None:
            raise HTTPException(status_code=422, detail="Choose a technician before approving.")
        technician = db.get(User, payload.technician_id)
        if not technician or technician.role != "technician" or not technician.is_active:
            raise HTTPException(status_code=422, detail="Choose an active technician account.")
        request.status = "Assigned"
        order = WorkOrder(
            public_id=f"WO-{secrets.token_hex(4).upper()}",
            request_id=request.id,
            technician_id=technician.id,
            status="Assigned",
        )
        db.add(order)
        db.flush()
        title, message = "Work order assigned", f"{order.public_id}: {request.title}"
    action = "request.approved" if payload.decision == "approve" else "request.rejected"
    add_log(db, actor, action, "request", request.public_id, request.review_remarks)
    audience = add_notification(db, title, message, "request", request.public_id, roles=("administrator",), users=(request.requester_id, *( [technician.id] if payload.decision == "approve" else [] )))
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="A work order already exists for this request.") from exc
    request = db.scalar(select(MaintenanceRequest).where(MaintenanceRequest.id == request_id).options(
        joinedload(MaintenanceRequest.requester), joinedload(MaintenanceRequest.work_order).joinedload(WorkOrder.technician)
    ))
    publish_after_commit(background, audience)
    return request_out(request)


@router.get("/work-orders", response_model=list[WorkOrderOut])
def list_work_orders(user: User = Depends(current_user), db: Session = Depends(get_db)):
    query = select(WorkOrder).options(
        joinedload(WorkOrder.request).joinedload(MaintenanceRequest.requester),
        joinedload(WorkOrder.technician),
        joinedload(WorkOrder.updates).joinedload(RepairUpdate.author),
    )
    if user.role == "technician":
        query = query.where(WorkOrder.technician_id == user.id)
    elif user.role == "requester":
        query = query.join(MaintenanceRequest).where(MaintenanceRequest.requester_id == user.id)
    orders = db.scalars(query.order_by(WorkOrder.assigned_at.desc())).unique().all()
    return [work_order_out(order) for order in orders]


@router.post("/work-orders/{order_id}/accept", response_model=WorkOrderOut)
def accept_work_order(
    order_id: int,
    payload: WorkAcceptIn,
    background: BackgroundTasks,
    actor: User = Depends(require_roles("technician")),
    db: Session = Depends(get_db),
):
    order = db.scalar(select(WorkOrder).where(WorkOrder.id == order_id).with_for_update())
    if not order or order.technician_id != actor.id:
        raise HTTPException(status_code=404, detail="Assigned work order not found.")
    if order.version != payload.expected_version or order.status != "Assigned":
        raise HTTPException(status_code=409, detail="This assignment changed or is no longer awaiting acceptance.")
    order.status = "In Progress"
    order.version += 1
    order.request.status = "In Progress"
    order.request.version += 1
    db.add(RepairUpdate(work_order_id=order.id, author_id=actor.id, note="Assignment accepted; repair work started."))
    add_log(db, actor, "work_order.accepted", "work_order", order.public_id)
    audience = add_notification(
        db, "Technician accepted work order", order.public_id, "work_order", order.public_id,
        roles=("coordinator", "administrator"), users=(order.request.requester_id,),
    )
    db.commit()
    order = db.scalar(select(WorkOrder).where(WorkOrder.id == order_id).options(
        joinedload(WorkOrder.request).joinedload(MaintenanceRequest.requester),
        joinedload(WorkOrder.technician),
        joinedload(WorkOrder.updates).joinedload(RepairUpdate.author),
    ))
    publish_after_commit(background, audience)
    return work_order_out(order)


@router.post("/work-orders/{order_id}/updates", response_model=WorkOrderOut)
def update_work_order(
    order_id: int,
    payload: WorkUpdateIn,
    background: BackgroundTasks,
    actor: User = Depends(require_roles("technician")),
    db: Session = Depends(get_db),
):
    order = db.scalar(select(WorkOrder).where(WorkOrder.id == order_id).with_for_update())
    if order is None or order.technician_id != actor.id:
        raise HTTPException(status_code=404, detail="Assigned work order not found.")
    if order.status not in ("In Progress", "Reopened"):
        raise HTTPException(status_code=409, detail="This work order cannot accept repair updates.")
    if order.status == "Reopened":
        order.status = "In Progress"
    update = RepairUpdate(work_order_id=order.id, author_id=actor.id, note=payload.note.strip())
    db.add(update)
    if payload.submit_for_verification:
        order.status = "For Verification"
    order.version += 1
    order.request.status = order.status
    order.request.version += 1
    add_log(db, actor, "work_order.updated", "work_order", order.public_id, payload.note.strip())
    roles = ("administrator", "coordinator") if payload.submit_for_verification else ("administrator", "coordinator")
    audience = add_notification(
        db,
        "Repair submitted for verification" if payload.submit_for_verification else "Repair progress updated",
        f"{order.public_id}: {payload.note.strip()}",
        "work_order", order.public_id, roles=roles, users=(order.request.requester_id,),
    )
    db.commit()
    order = db.scalar(select(WorkOrder).where(WorkOrder.id == order_id).options(
        joinedload(WorkOrder.request).joinedload(MaintenanceRequest.requester),
        joinedload(WorkOrder.technician),
        joinedload(WorkOrder.updates).joinedload(RepairUpdate.author),
    ))
    publish_after_commit(background, audience)
    return work_order_out(order)


@router.post("/work-orders/{order_id}/verify", response_model=WorkOrderOut)
def verify_work_order(
    order_id: int,
    payload: VerificationIn,
    background: BackgroundTasks,
    actor: User = Depends(require_roles("administrator")),
    db: Session = Depends(get_db),
):
    order = db.scalar(select(WorkOrder).where(WorkOrder.id == order_id).with_for_update())
    if order is None:
        raise HTTPException(status_code=404, detail="Work order not found.")
    if order.version != payload.expected_version:
        raise HTTPException(status_code=409, detail="This work order changed elsewhere. Refresh and try again.")
    if order.status != "For Verification":
        raise HTTPException(status_code=409, detail="Only submitted repairs can be verified.")
    order.status = "Completed" if payload.verified else "Reopened"
    order.completed_at = datetime.now(timezone.utc) if payload.verified else None
    order.version += 1
    order.request.status = order.status
    order.request.review_remarks = payload.remarks.strip()
    order.request.version += 1
    db.add(RepairUpdate(work_order_id=order.id, author_id=actor.id, note=f"Verification: {payload.remarks.strip()}"))
    add_log(db, actor, "work_order.verified" if payload.verified else "work_order.returned", "work_order", order.public_id, payload.remarks.strip())
    title = "Repair verified" if payload.verified else "Repair returned for rework"
    audience = add_notification(
        db, title, f"{order.public_id}: {payload.remarks.strip()}", "work_order", order.public_id,
        roles=("coordinator",), users=(order.technician_id, order.request.requester_id),
    )
    db.commit()
    order = db.scalar(select(WorkOrder).where(WorkOrder.id == order_id).options(
        joinedload(WorkOrder.request).joinedload(MaintenanceRequest.requester),
        joinedload(WorkOrder.technician),
        joinedload(WorkOrder.updates).joinedload(RepairUpdate.author),
    ))
    publish_after_commit(background, audience)
    return work_order_out(order)


@router.post("/work-orders/{order_id}/reassign", response_model=WorkOrderOut)
def reassign_work_order(
    order_id: int,
    payload: ReassignIn,
    background: BackgroundTasks,
    actor: User = Depends(require_roles("coordinator")),
    db: Session = Depends(get_db),
):
    order = db.scalar(select(WorkOrder).where(WorkOrder.id == order_id).with_for_update())
    if not order:
        raise HTTPException(status_code=404, detail="Work order not found.")
    if order.version != payload.expected_version or order.status not in ("Assigned", "In Progress", "Reopened"):
        raise HTTPException(status_code=409, detail="Work order changed or cannot be reassigned.")
    technician = db.get(User, payload.technician_id)
    if not technician or technician.role != "technician" or not technician.is_active:
        raise HTTPException(status_code=422, detail="Choose an active technician account.")
    previous_id = order.technician_id
    order.technician_id = technician.id
    order.status = "Assigned"
    order.version += 1
    order.request.status = "Assigned"
    order.request.version += 1
    add_log(db, actor, "work_order.reassigned", "work_order", order.public_id, f"Technician {previous_id} -> {technician.id}")
    audience = add_notification(db, "Work order reassigned", order.public_id, "work_order", order.public_id, users=(previous_id, technician.id))
    db.commit()
    order = db.scalar(select(WorkOrder).where(WorkOrder.id == order_id).options(
        joinedload(WorkOrder.request).joinedload(MaintenanceRequest.requester),
        joinedload(WorkOrder.technician),
        joinedload(WorkOrder.updates).joinedload(RepairUpdate.author),
    ))
    publish_after_commit(background, audience)
    return work_order_out(order)


@router.get("/notifications", response_model=list[NotificationOut])
def list_notifications(user: User = Depends(current_user), db: Session = Depends(get_db)):
    query = (
        select(Notification, NotificationReceipt)
        .outerjoin(NotificationReceipt, (NotificationReceipt.notification_id == Notification.id) & (NotificationReceipt.user_id == user.id))
        .where(or_(Notification.user_id == user.id, Notification.target_role == user.role))
        .order_by(Notification.created_at.desc())
        .limit(100)
    )
    return [
        NotificationOut(
            id=notification.id,
            title=notification.title,
            message=notification.message,
            entity_type=notification.entity_type,
            entity_id=notification.entity_id,
            read_at=receipt.read_at if receipt else None,
            created_at=notification.created_at,
        )
        for notification, receipt in db.execute(query)
    ]


@router.post("/notifications/{notification_id}/read", status_code=204)
def mark_notification_read(notification_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    notification = db.get(Notification, notification_id)
    if not notification or (notification.user_id != user.id and notification.target_role != user.role):
        raise HTTPException(status_code=404, detail="Notification not found.")
    receipt = db.scalar(select(NotificationReceipt).where(
        NotificationReceipt.notification_id == notification_id, NotificationReceipt.user_id == user.id
    ))
    if not receipt:
        db.add(NotificationReceipt(notification_id=notification_id, user_id=user.id))
    db.commit()


@router.post("/stations/heartbeat", status_code=204)
def station_heartbeat(payload: StationHeartbeatIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    station = db.get(StationRegistry, payload.station_id)
    now = datetime.now(timezone.utc)
    if station:
        if station.user_id != user.id:
            raise HTTPException(status_code=409, detail="Station identifier is already registered to another account.")
        station.role = user.role
        station.last_seen_at = now
    else:
        db.add(StationRegistry(station_id=payload.station_id, role=user.role, user_id=user.id, last_seen_at=now))
    db.commit()


@router.get("/stations")
def list_stations(_: User = Depends(require_roles("administrator")), db: Session = Depends(get_db)):
    now = datetime.now(timezone.utc)
    result = []
    for station in db.scalars(select(StationRegistry).options(joinedload(StationRegistry.user)).order_by(StationRegistry.station_id)).all():
        last_seen = station.last_seen_at
        if last_seen.tzinfo is None:
            last_seen = last_seen.replace(tzinfo=timezone.utc)
        result.append({
            "station_id": station.station_id,
            "role": station.role,
            "user_name": station.user.name,
            "last_seen_at": last_seen,
            "connected": (now - last_seen).total_seconds() < 45,
        })
    return result


@router.get("/dashboard")
def dashboard(user: User = Depends(current_user), db: Session = Depends(get_db)):
    query = select(MaintenanceRequest)
    if user.role == "requester":
        query = query.where(MaintenanceRequest.requester_id == user.id)
    requests = db.scalars(query).all()
    visible_ids = {row.id for row in requests}
    if user.role == "technician":
        orders = db.scalars(select(WorkOrder).where(WorkOrder.technician_id == user.id)).all()
        orders_by_status = {status: sum(order.status == status for order in orders) for status in ("Assigned", "In Progress", "For Verification", "Completed")}
        return {"total": len(orders), "by_status": orders_by_status}
    counts = {status: sum(row.status == status for row in requests) for status in ("Pending", "Under Review", "Assigned", "In Progress", "For Verification", "Completed", "Rejected", "Cancelled", "Reopened")}
    by_category: dict[str, int] = {}
    for row in requests:
        by_category[row.category] = by_category.get(row.category, 0) + 1
    urgent = sum(row.priority == "Urgent" and row.status not in ("Completed", "Rejected", "Cancelled") for row in requests)
    workload = []
    if user.role in ("coordinator", "administrator"):
        for tech in db.scalars(select(User).where(User.role == "technician", User.is_active.is_(True)).order_by(User.name)).all():
            workload.append({
                "technician": tech.name,
                "active": db.scalar(select(func.count(WorkOrder.id)).where(WorkOrder.technician_id == tech.id, WorkOrder.status.in_(("Assigned", "In Progress", "Reopened")))) or 0,
            })
    return {
        "total": len(requests),
        "by_status": counts,
        "by_category": by_category,
        "urgent": urgent,
        "technician_workload": workload,
        "recent": [request_out(row).model_dump(mode="json") for row in sorted(requests, key=lambda item: item.created_at, reverse=True)[:6]],
        "visible_request_ids": len(visible_ids),
    }


@router.get("/reports/maintenance.csv")
def export_report(
    status_filter: str | None = Query(default=None, alias="status"),
    location: str | None = None,
    technician_id: int | None = None,
    start_date: date | None = None,
    end_date: date | None = None,
    user: User = Depends(require_roles("coordinator", "administrator")),
    db: Session = Depends(get_db),
):
    query = select(MaintenanceRequest).options(joinedload(MaintenanceRequest.requester))
    if technician_id is not None:
        query = query.join(WorkOrder).where(WorkOrder.technician_id == technician_id)
    if status_filter:
        query = query.where(MaintenanceRequest.status == status_filter)
    if location:
        query = query.where(MaintenanceRequest.building.ilike(f"%{location}%"))
    if start_date and end_date and end_date < start_date:
        raise HTTPException(status_code=422, detail="end_date must be on or after start_date.")
    if start_date:
        query = query.where(MaintenanceRequest.created_at >= datetime.combine(start_date, time.min, tzinfo=timezone.utc))
    if end_date:
        query = query.where(MaintenanceRequest.created_at < datetime.combine(end_date + timedelta(days=1), time.min, tzinfo=timezone.utc))
    rows = db.scalars(query.order_by(MaintenanceRequest.created_at.desc())).all()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Request ID", "Title", "Requester", "Category", "Building", "Room", "Priority", "Status", "Created"])
    for row in rows:
        writer.writerow([row.public_id, row.title, row.requester.name, row.category, row.building, row.room, row.priority, row.status, row.created_at.isoformat()])
    output.seek(0)
    return StreamingResponse(output, media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="maintenance-report.csv"'})


@router.get("/audit")
def audit_logs(
    limit: int = Query(default=100, ge=1, le=500),
    _: User = Depends(require_roles("administrator")),
    db: Session = Depends(get_db),
):
    rows = db.scalars(select(ActivityLog).options(joinedload(ActivityLog.actor)).order_by(ActivityLog.created_at.desc()).limit(limit)).all()
    return [{
        "id": row.id, "actor": row.actor.name, "action": row.action, "entity_type": row.entity_type,
        "entity_id": row.entity_id, "details": row.details, "created_at": row.created_at,
    } for row in rows]


async def websocket_endpoint(websocket: WebSocket, token: str, db: Session = Depends(get_db)):
    try:
        user_id = decode_access_token(token)
    except ValueError:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    user = db.get(User, user_id)
    if not user or not user.is_active:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    role = user.role
    await manager.connect(user_id, role, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await manager.disconnect(websocket)

