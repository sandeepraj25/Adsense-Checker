import { isSupportedCountry, parsePhoneNumberFromString } from "libphonenumber-js/max";
import type { CountryCode } from "libphonenumber-js";

import { validateBilling, type BillingInput } from "@/lib/billing-details";

/**
 * The authoritative check, with libphonenumber's full metadata: exact
 * number patterns per country, not just plausible lengths.
 */
export function validateBillingOnServer(input: Partial<Record<keyof BillingInput, unknown>>) {
  return validateBilling(
    input,
    (number, country) => parsePhoneNumberFromString(number, country),
    (value): value is CountryCode => isSupportedCountry(value),
  );
}
