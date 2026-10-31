// Time-of-day greeting buckets per UI language. Kept in one place so Home and
// any future surface agree on the boundaries.
//
// English: morning / afternoon / evening.
// Indonesian: pagi / siang / sore / malam (traditional splits).

export function getGreetingKey(date = new Date(), language = 'en') {
  const hour = date.getHours()
  if (language === 'id') {
    if (hour >= 4 && hour < 11) return 'greeting.pagi'
    if (hour >= 11 && hour < 15) return 'greeting.siang'
    if (hour >= 15 && hour < 19) return 'greeting.sore'
    return 'greeting.malam'
  }
  if (hour >= 5 && hour < 12) return 'greeting.morning'
  if (hour >= 12 && hour < 18) return 'greeting.afternoon'
  return 'greeting.evening'
}
