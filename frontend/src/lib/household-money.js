// The household money formatter: the ONE frontend definition of how a
// household money figure renders (#597 — the Plan/History split rendered the
// same amount as "Rp 56.000" on Plan and "IDR 65,000" on History, switching
// on the viewer's UI language).
//
// Household-scoped, like the household day (lib/household-date.js): the
// display locale is the household's convention — id-ID — deliberately NOT the
// viewer's UI language. The household calendar is WIB, its receipts and
// totals are rupiah, and the app's other money surfaces already render id-ID
// (lib/pricesHelpers.js formatPrice, the #292 precedent): the money figure is
// data about the household — one stable, comparable string — while the copy
// around it still translates. History's i18n switch was the deviation this
// closes. The currency rides the household settings where the page has it
// (Plan); the default mirrors the API's currency default.
export function formatHouseholdMoney(amount, currency = 'IDR') {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
  }).format(amount)
}
