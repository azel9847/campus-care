export type Role = "requester" | "coordinator" | "technician" | "administrator";

export interface CatalogItem {
  id: number;
  name: string;
  is_active: boolean;
}

export interface CampusCatalog {
  categories: CatalogItem[];
  locations: CatalogItem[];
}

export interface User {
  id: number;
  name: string;
  email: string;
  role: Role;
  is_active: boolean;
}

export interface Attachment {
  public_id: string;
  filename: string;
  content_type: string;
  created_at: string;
}

export interface MaintenanceRequest {
  id: number;
  public_id: string;
  requester_id: number;
  requester_name: string;
  requester_email: string;
  title: string;
  description: string;
  category: string;
  building: string;
  room: string;
  status: string;
  priority: string;
  review_remarks: string;
  version: number;
  created_at: string;
  updated_at: string;
  work_order_id: string | null;
  technician_name: string | null;
  attachments: Attachment[];
}

export interface RepairUpdate {
  id: number;
  note: string;
  author_name: string;
  created_at: string;
}

export interface WorkOrder {
  id: number;
  public_id: string;
  request_id: string;
  title: string;
  description: string;
  category: string;
  building: string;
  room: string;
  priority: string;
  requester_name: string;
  technician_id: number;
  technician_name: string;
  status: string;
  assigned_at: string;
  updated_at: string;
  completed_at: string | null;
  version: number;
  updates: RepairUpdate[];
  attachments: Attachment[];
}

export interface NotificationItem {
  id: number;
  title: string;
  message: string;
  entity_type: string;
  entity_id: string;
  read_at: string | null;
  created_at: string;
}

export interface DashboardData {
  total: number;
  by_status: Record<string, number>;
  by_category?: Record<string, number>;
  urgent?: number;
  technician_workload?: { technician: string; active: number }[];
  recent?: MaintenanceRequest[];
}
