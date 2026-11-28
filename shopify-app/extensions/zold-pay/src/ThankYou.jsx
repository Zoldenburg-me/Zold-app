import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { ZoldPay } from "./ZoldPay.jsx";

/**
 * Thank you page: the order has JUST been placed with the manual "Zold"
 * method and is payment-pending. `orderConfirmation` carries the new order's
 * id and `checkoutToken` the proof the API asks for; the Zold API's orders/create webhook opens the payment request at about
 * the same moment, so the block starts by polling until it exists.
 */
export default function extension() {
  render(<Entry />, document.body);
}

function Entry() {
  return (
    <ZoldPay
      orderId={shopify.orderConfirmation.value?.order?.id}
      checkoutToken={shopify.checkoutToken.value}
      shop={shopify.shop?.myshopifyDomain}
      apiBase={shopify.settings.value.api_base}
    />
  );
}
