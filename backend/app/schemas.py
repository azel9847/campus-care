from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


Role = Literal["requester", "coordinator", "technician", "administrator"]


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    email: str
    role: Role
    is_active: bool


class RegisterIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    email: str = Field(min_length=5, max_length=255)
    password: str = Field(min_length=10, max_length=128)


class LoginIn(BaseModel):
    email: str
    password: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class UserCreateIn(RegisterIn):
    role: Role


class UserActiveIn(BaseModel):
    is_active: bool


class CatalogCreateIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)


class CatalogActiveIn(BaseModel):
    is_active: bool


class RequestCreateIn(BaseModel):
    title: str = Field(min_length=4, max_length=180)
    description: str = Field(min_length=10, max_length=5000)
    category: str = Field(min_length=2, max_length=80)
    building: str = Field(min_length=2, max_length=120)
    room: str = Field(default="", max_length=80)


class RequestReviewIn(BaseModel):
    decision: Literal["approve", "reject"]
    priority: Literal["Low", "Medium", "High", "Urgent"] = "Medium"
    technician_id: int | None = None
    remarks: str = Field(default="", max_length=2000)
    expected_version: int = Field(ge=1)


class WorkUpdateIn(BaseModel):
    note: str = Field(min_length=3, max_length=3000)
    submit_for_verification: bool = False


class WorkAcceptIn(BaseModel):
    expected_version: int = Field(ge=1)


class VerificationIn(BaseModel):
    verified: bool
    remarks: str = Field(min_length=3, max_length=2000)
    expected_version: int = Field(ge=1)


class ReassignIn(BaseModel):
    technician_id: int
    expected_version: int = Field(ge=1)


class StationHeartbeatIn(BaseModel):
    station_id: str = Field(min_length=2, max_length=80)


class AttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    public_id: str
    filename: str
    content_type: str
    created_at: datetime


class RequestOut(BaseModel):
    id: int
    public_id: str
    requester_id: int
    requester_name: str
    requester_email: str
    title: str
    description: str
    category: str
    building: str
    room: str
    status: str
    priority: str
    review_remarks: str
    version: int
    created_at: datetime
    updated_at: datetime
    work_order_id: str | None = None
    technician_name: str | None = None
    attachments: list[AttachmentOut] = Field(default_factory=list)


class RepairUpdateOut(BaseModel):
    id: int
    note: str
    author_name: str
    created_at: datetime


class WorkOrderOut(BaseModel):
    id: int
    public_id: str
    request_id: str
    title: str
    description: str
    category: str
    building: str
    room: str
    priority: str
    requester_name: str
    technician_id: int
    technician_name: str
    status: str
    assigned_at: datetime
    updated_at: datetime
    completed_at: datetime | None
    version: int
    updates: list[RepairUpdateOut]
    attachments: list[AttachmentOut] = Field(default_factory=list)


class NotificationOut(BaseModel):
    id: int
    title: str
    message: str
    entity_type: str
    entity_id: str
    read_at: datetime | None
    created_at: datetime



