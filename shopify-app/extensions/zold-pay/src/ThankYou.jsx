import * as ui from "@shopify/ui-extensions-react/checkout";
import { ZoldPay } from "./ZoldPay.jsx";

/**
 * Thank you page: the order has JUST been placed with the manual "Zold"
 * method and is payment-pending. `orderConfirmation` carries the new order's
 * id; the Zold API's orders/create webhook opens the payment request at about
 * the same moment, so the block starts by polling until it exists.
 */
export default ui.reactExtension("purchase.thank-you.block.render", () => <Entry />);

function Entry() {
  const api = ui.useApi();
  const confirmation = ui.useSubscription(api.orderConfirmation);
  const settings = ui.useSettings();
  return (
    <ZoldPay
      ui={ui}
      orderId={confirmation?.order?.id}
      shop={api.shop?.myshopifyDomain}
      apiBase={settings.api_base}
      surface="thank-you"
    />
  );
}
