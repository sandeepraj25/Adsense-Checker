import type { CountryCode, PhoneNumber } from "libphonenumber-js";

import { normalizeEmail, validateEmail } from "@/lib/validate";

/**
 * Billing details collected at checkout — one set of rules for the form
 * and the API, so they can never disagree about what is valid.
 *
 * The phone parser is injected: the browser passes the small metadata
 * build (instant feedback, small bundle), the server passes the full one
 * (exact per-country number patterns). The server's answer is the one
 * that counts; the form's is a convenience.
 *
 * Nothing here is a payment credential. Card numbers, UPI PINs and bank
 * passwords are entered only on the gateway's own page or sheet.
 */

export const DEFAULT_BILLING_COUNTRY: CountryCode = "IN";

export type BillingInput = {
  name: string;
  email: string;
  country: string;
  phone: string;
};

export type BillingDetails = {
  name: string;
  email: string;
  country: CountryCode;
  /** E.164, e.g. +919876543210 */
  phone: string;
};

export type PhoneParser = (number: string, country: CountryCode) => PhoneNumber | undefined;

export type BillingErrors = Partial<Record<keyof BillingInput, string>>;

const NAME_MAX = 100;

/**
 * A legal name, in any script. Letters (with their combining marks),
 * spaces, and the punctuation real names use — apostrophes, hyphens,
 * periods, commas. Digits, symbols and control characters are refused.
 */
export function validateLegalName(raw: string): string | null {
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!name) return "Enter your full legal name";
  if (name.length < 2) return "That name looks too short";
  if (name.length > NAME_MAX) return `Keep the name under ${NAME_MAX} characters`;
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .,'’-]*$/u.test(name)) {
    return "Use letters, spaces and . , ' - only";
  }
  if (!/\p{L}.*\p{L}/u.test(name)) return "That name looks too short";
  return null;
}

export function cleanLegalName(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/g, " ").trim();
}

export function validateBilling(
  input: Partial<Record<keyof BillingInput, unknown>>,
  parsePhone: PhoneParser,
  isCountry: (value: string) => value is CountryCode,
): { ok: true; details: BillingDetails } | { ok: false; errors: BillingErrors } {
  const errors: BillingErrors = {};
  const str = (value: unknown) => (typeof value === "string" ? value : "");

  const name = cleanLegalName(str(input.name));
  const nameError = validateLegalName(name);
  if (nameError) errors.name = nameError;

  const email = normalizeEmail(str(input.email));
  const emailError = validateEmail(email);
  if (emailError) errors.email = emailError;

  const country = str(input.country).trim().toUpperCase();
  let phone = "";
  if (!isCountry(country)) {
    errors.country = "Choose a country code";
  } else {
    const digits = str(input.phone).trim();
    if (!digits) {
      errors.phone = "Enter your phone number";
    } else if (!/^[0-9 ()+.-]{4,24}$/.test(digits)) {
      errors.phone = "Use digits only";
    } else {
      const parsed = parsePhone(digits, country);
      if (!parsed || !parsed.isValid()) {
        errors.phone = "That number is not valid for the selected country";
      } else {
        phone = parsed.number; // E.164
      }
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, details: { name, email, country: country as CountryCode, phone } };
}
