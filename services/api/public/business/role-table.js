/**
 * What each role may do, as the API's permission table has it. No DOM, so
 * scripts/role-table-test.ts imports it.
 */
/* Each key is one server permission set (src/domain/roles.ts): propose =
 * drafts.create, approve = drafts.review, queue = transfers.queue, sign =
 * transfers.sign, categorise = ledger.categorise + coa.manage + reports.run,
 * invoices = invoices.manage, contacts = contacts.manage, wallets / members /
 * accounts = wallets.manage / members.invite + update / accounts.open.
 * scripts/role-table-test.ts checks both tables against the server's. */
const ADMIN_CAN = { propose: true, approve: true, queue: true, sign: true, categorise: true, wallets: true, invoices: true, contacts: true, members: true, accounts: true };
export const ROLE_CAN = {
  owner: ADMIN_CAN,
  admin: ADMIN_CAN,
  payer: { propose: true, queue: true, sign: true, invoices: true, contacts: true },
  accountant: { propose: true, categorise: true, contacts: true },
  viewer: {},
};
/* A company's Safe is signed by its owners only (COMPANY_ROLE_PERMISSIONS). */
export const COMPANY_ROLE_CAN = Object.fromEntries(Object.entries(ROLE_CAN).map(([r, c]) => [r, { ...c, sign: r === "owner" && !!c.sign }]));
export const roleTableFor = (entity) => (entity === "company" ? COMPANY_ROLE_CAN : ROLE_CAN);
