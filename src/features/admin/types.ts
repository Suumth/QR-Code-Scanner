export interface AdminEvent {
  id: string;
  publicId: string;
  name: string;
  eventDate: string;
  createdAt: string;
}

export interface AdminSummary {
  issuedCount: number;
  availableCount: number;
  redeemedCount: number;
}

export interface AdminSponsor extends AdminSummary {
  id: string;
  name: string;
  accessId: string;
  createdAt: string;
  voucherTypes: AdminVoucherType[];
}

export interface AdminVoucherType extends AdminSummary {
  id: string;
  name: string;
}

export type AdminTeamSessionStatus = "active" | "revoked" | "expired" | "superseded";

export interface AdminTeamSession {
  displayName: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
  status: AdminTeamSessionStatus;
}

export interface AdminEventDetail {
  event: AdminEvent;
  summary: AdminSummary;
  sponsors: AdminSponsor[];
  sponsorsNextCursor: string | null;
  teamSessions: AdminTeamSession[];
}

export interface AdminSponsorPage {
  sponsors: AdminSponsor[];
  nextCursor: string | null;
}

export type AdminQrExportVoucherStatus = "available" | "redeemed";

export interface AdminQrExportVoucher {
  publicId: string;
  displayCode: string;
  status: AdminQrExportVoucherStatus;
}

export interface AdminQrExportData {
  sponsorName: string;
  voucherTypeName: string;
  vouchers: AdminQrExportVoucher[];
}

export interface CreateEventInput {
  name: string;
  eventDate: string;
  teamPin: string;
}

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}
