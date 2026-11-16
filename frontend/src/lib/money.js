// The ONE household money formatter (audit 2026-11-16 L9): every money
// figure in the app renders through this export — nothing re-implements it.
//
// Household-scoped, like the household day (lib/household-date.js): the
// display locale is the household's convention — id-ID — deliberately NOT
// the viewer's UI language. The household calendar is WIB, its receipts and
// totals are rupiah, and the money figure is data about the household — one
// stable, comparable string ("Rp 56.000" everywhere) — while the copy around
// it still translates. History's i18n switch was the #597 deviation this
// closes; pricesHelpers.formatPrice is the IDR-locked alias the catalog
// surfaces call (#292: Intl id-ID puts an NBSP between "Rp" and the amount).
// The currency rides the household settings where the page has it (Plan);
// the default mirrors the API's currency default.
export function formatMoney(amount, currency = 'IDR') {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
  }).format(amount)
}
