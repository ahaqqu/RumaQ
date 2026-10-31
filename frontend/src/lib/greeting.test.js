import { describe, it, expect } from 'vite-plus/test'
import { getGreetingKey } from './greeting.js'

describe('getGreetingKey', () => {
  const at = (hour, language) => getGreetingKey(new Date(2026, 9, 12, hour, 0, 0), language)

  it('buckets English by morning / afternoon / evening', () => {
    expect(at(5, 'en')).toBe('greeting.morning')
    expect(at(11, 'en')).toBe('greeting.morning')
    expect(at(12, 'en')).toBe('greeting.afternoon')
    expect(at(17, 'en')).toBe('greeting.afternoon')
    expect(at(18, 'en')).toBe('greeting.evening')
    expect(at(4, 'en')).toBe('greeting.evening')
  })

  it('buckets Indonesian into pagi / siang / sore / malam', () => {
    expect(at(4, 'id')).toBe('greeting.pagi')
    expect(at(10, 'id')).toBe('greeting.pagi')
    expect(at(11, 'id')).toBe('greeting.siang')
    expect(at(14, 'id')).toBe('greeting.siang')
    expect(at(15, 'id')).toBe('greeting.sore')
    expect(at(18, 'id')).toBe('greeting.sore')
    expect(at(19, 'id')).toBe('greeting.malam')
    expect(at(3, 'id')).toBe('greeting.malam')
  })

  it('defaults to the English buckets for unknown languages', () => {
    expect(at(9, 'fr')).toBe('greeting.morning')
  })

  it('defaults to the current time', () => {
    expect(typeof getGreetingKey()).toBe('string')
  })
})
