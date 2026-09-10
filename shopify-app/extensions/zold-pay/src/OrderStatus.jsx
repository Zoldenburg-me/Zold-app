import * as ui from "@shopify/ui-extensions-react/customer-account";
import { ZoldPay } from "./ZoldPay.jsx";

/**
 * Order status page: the buyer came back (from the confirmation email, or
 * the account's order list). Same block; the payment may be OPEN still, PAID
 * (the order shows paid too), or EXPIRED, and each is said as it is.
 */
export default ui.reactExtension("customer-account.order-status.block.render", () => <Entry />);

function Entry() {
  const api = ui.useApi();
  const order = ui.useSubscription(api.order);
  const settings = ui.useSettings();
  return (
    <ZoldPay
      ui={ui}
      orderId={order?.id}
      shop={api.shop?.myshopifyDomain}
      apiBase={settings.api_base}
      surface="order-status"
    />
  );
}
