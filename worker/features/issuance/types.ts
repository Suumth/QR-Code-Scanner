export interface SafeSponsor {
  id: string;
  eventId: string;
  name: string;
  accessId: string;
  createdAt: string;
}

export interface NewVoucher {
  id: string;
  publicId: string;
  eventId: string;
  sponsorId: string;
  voucherTypeId: string;
  displayCode: string;
  createdAt: string;
}
