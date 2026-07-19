import { sha256Name } from '../security';

export async function storePageObjectName(
  merchantId: string,
  pageId: string,
): Promise<string> {
  return `store-${await sha256Name(['store-page', merchantId, pageId])}`;
}

export async function customerThreadObjectName(
  merchantId: string,
  pageId: string,
  customerPsid: string,
): Promise<string> {
  return `thread-${await sha256Name(['customer-thread', merchantId, pageId, customerPsid])}`;
}
