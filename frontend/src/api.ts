import type {
  DashboardData,
  Attachment,
  CampusCatalog,
  CatalogItem,
  MaintenanceRequest,
  NotificationItem,
  User,
  WorkOrder,
} from "./types";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api";
const TOKEN_KEY = "campuscare.token";

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}, token = localStorage.getItem(TOKEN_KEY)): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const body = await response.json() as { detail?: string };
      message = body.detail ?? message;
    } catch {
      message = response.statusText || message;
    }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const authApi = {
  login: (email: string, password: string) =>
    api<{ access_token: string; user: User }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }, null),
  register: (name: string, email: string, password: string) =>
    api<{ access_token: string; user: User }>("/auth/register", { method: "POST", body: JSON.stringify({ name, email, password }) }, null),
  me: () => api<User>("/auth/me"),
};

export const requestsApi = {
  list: (filters = "") => api<MaintenanceRequest[]>(`/requests${filters}`),
  create: (body: Record<string, string>, key: string) =>
    api<MaintenanceRequest>("/requests", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(body) }),
  uploadPhoto: (requestId: number, image: File) => {
    const form = new FormData();
    form.append("file", image);
    return api<Attachment>(`/requests/${requestId}/attachments`, { method: "POST", body: form });
  },
  cancel: (id: number) => api<void>(`/requests/${id}`, { method: "DELETE" }),
  review: (id: number, body: Record<string, unknown>) =>
    api<MaintenanceRequest>(`/requests/${id}/review`, { method: "POST", body: JSON.stringify(body) }),
};

export const workOrdersApi = {
  list: () => api<WorkOrder[]>("/work-orders"),
  accept: (id: number, expected_version: number) =>
    api<WorkOrder>(`/work-orders/${id}/accept`, { method: "POST", body: JSON.stringify({ expected_version }) }),
  uploadPhoto: (orderId: number, image: File) => {
    const form = new FormData();
    form.append("file", image);
    return api<Attachment>(`/work-orders/${orderId}/attachments`, { method: "POST", body: form });
  },
  reassign: (id: number, technician_id: number, expected_version: number) =>
    api<WorkOrder>(`/work-orders/${id}/reassign`, { method: "POST", body: JSON.stringify({ technician_id, expected_version }) }),
  update: (id: number, note: string, submit_for_verification: boolean) =>
    api<WorkOrder>(`/work-orders/${id}/updates`, { method: "POST", body: JSON.stringify({ note, submit_for_verification }) }),
  verify: (id: number, verified: boolean, remarks: string, expected_version: number) =>
    api<WorkOrder>(`/work-orders/${id}/verify`, { method: "POST", body: JSON.stringify({ verified, remarks, expected_version }) }),
};

export const dashboardApi = {
  get: () => api<DashboardData>("/dashboard"),
  users: (role?: string) => api<User[]>(`/users${role ? `?role=${role}` : ""}`),
  createUser: (data: { name: string; email: string; password: string; role: string }) =>
    api<User>("/users", { method: "POST", body: JSON.stringify(data) }),
  setUserActive: (id: number, is_active: boolean) =>
    api<User>(`/users/${id}/status`, { method: "PATCH", body: JSON.stringify({ is_active }) }),
  catalog: () => api<CampusCatalog>("/catalog"),
  allCatalog: (kind: "categories" | "locations") => api<CatalogItem[]>(`/catalog/${kind}/all`),
  createCatalogItem: (kind: "categories" | "locations", name: string) =>
    api<CatalogItem>(`/catalog/${kind}`, { method: "POST", body: JSON.stringify({ name }) }),
  setCatalogActive: (kind: "categories" | "locations", id: number, is_active: boolean) =>
    api<CatalogItem>(`/catalog/${kind}/${id}`, { method: "PATCH", body: JSON.stringify({ is_active }) }),
  notifications: () => api<NotificationItem[]>("/notifications"),
  stations: () => api<Station[]>("/stations"),
  audit: () => api<AuditEntry[]>("/audit"),
  heartbeat: (station_id: string) => api<void>("/stations/heartbeat", { method: "POST", body: JSON.stringify({ station_id }) }),
};

export interface Station {
  station_id: string;
  role: string;
  user_name: string;
  last_seen_at: string;
  connected: boolean;
}

export interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
  details: string;
  created_at: string;
}

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const saveToken = (token: string | null) => token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY);
export const apiBase = API_BASE;

export function newOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export async function openAttachment(publicId: string): Promise<void> {
  const preview = window.open("about:blank", "_blank");
  if (preview) preview.opener = null;
  const response = await fetch(`${API_BASE}/attachments/${encodeURIComponent(publicId)}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!response.ok) {
    preview?.close();
    throw new ApiError("The attachment could not be opened.", response.status);
  }
  const url = URL.createObjectURL(await response.blob());
  if (preview) {
    preview.location.href = url;
  } else {
    const link = document.createElement("a");
    link.href = url;
    link.download = "campus-maintenance-image";
    link.click();
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
