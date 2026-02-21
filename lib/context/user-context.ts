/**
 * Infer user timezone and country from phone number.
 * Uses libphonenumber-js (phone → country code) and countries-and-timezones (country → timezone).
 * Resolved on every request; no DB storage.
 */

import parsePhoneNumber from 'libphonenumber-js'
import { getCountry } from 'countries-and-timezones'

export interface UserTimeContext {
  timezone: string
  country?: string
}

/**
 * Get timezone and country from phone number. Returns UTC and no country if unknown.
 */
function toE164(phone: string): string {
  const digits = (phone || '').replace(/\D/g, '')
  return digits.length > 0 ? `+${digits}` : ''
}

export function getTimezoneFromPhone(phoneNumber: string): UserTimeContext {
  if (!phoneNumber || typeof phoneNumber !== 'string') return { timezone: 'UTC' }
  const e164 = toE164(phoneNumber)
  if (!e164) return { timezone: 'UTC' }
  try {
    const p = parsePhoneNumber(e164)
    const countryCode = p?.country
    if (!countryCode) return { timezone: 'UTC' }

    const country = getCountry(countryCode)
    if (!country?.timezones?.length) return { timezone: 'UTC', country: country?.name }

    return {
      timezone: country.timezones[0],
      country: country.name,
    }
  } catch {
    return { timezone: 'UTC' }
  }
}

/**
 * Format current date and time in the user's timezone for prompts.
 */
export function formatNowInTimezone(timezone: string): string {
  try {
    return new Date().toLocaleString('en-GB', {
      timeZone: timezone,
      dateStyle: 'full',
      timeStyle: 'short',
      hour12: false,
    })
  } catch {
    return new Date().toISOString()
  }
}
