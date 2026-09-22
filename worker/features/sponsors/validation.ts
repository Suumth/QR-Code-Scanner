const SPONSOR_ACCESS_ID = /^[A-Za-z0-9_-]{32}$/;
const VOUCHER_PUBLIC_ID = /^[A-Za-z0-9_-]{22}$/;

export function isSponsorAccessId(value: string): boolean {
  return SPONSOR_ACCESS_ID.test(value);
}

export function isVoucherPublicId(value: string): boolean {
  return VOUCHER_PUBLIC_ID.test(value);
}
