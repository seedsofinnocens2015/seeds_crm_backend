/**
 * Standard Phone Normalization Utility for Indian Phone Numbers & Formats
 * Supports:
 * - 10-digit Indian standard (e.g. "9876543210")
 * - Country code +91 prefix (e.g. "+91 98765-43210")
 * - 91 prefix (e.g. "919876543210")
 * - Leading 0 trunk prefix (e.g. "09876543210")
 * - International standard E.164 with formatting characters (spaces, hyphens, parentheses)
 * 
 * Rules:
 * 1. Strips all non-digit characters.
 * 2. If 10 digits and starts with 6, 7, 8, or 9: valid Indian mobile -> returns 10-digit string.
 * 3. If 11 digits and starts with '0' followed by [6-9]: strip leading 0 -> returns 10-digit string.
 * 4. If 12 digits and starts with '91' followed by [6-9]: strip country code '91' -> returns 10-digit string.
 * 5. If input does not match Indian mobile pattern, returns the cleaned digit string if >= 7 digits, or null if invalid.
 */
export function normalizePhoneNumber(rawPhone: any): string | null {
  if (!rawPhone && rawPhone !== 0) return null;
  const str = String(rawPhone).trim();
  if (!str) return null;

  // Extract digits only
  const digits = str.replace(/\D/g, "");

  // 10 digits: Indian mobile must start with 6, 7, 8, or 9
  if (digits.length === 10) {
    if (/^[6-9]\d{9}$/.test(digits)) {
      return digits;
    }
    // Landline or special non-standard 10-digit number
    return digits;
  }

  // 11 digits starting with 0 (e.g. 09876543210)
  if (digits.length === 11 && digits.startsWith("0")) {
    const candidate = digits.slice(1);
    if (/^[6-9]\d{9}$/.test(candidate)) {
      return candidate;
    }
    return candidate;
  }

  // 12 digits starting with 91 (e.g. 919876543210 or +919876543210)
  if (digits.length === 12 && digits.startsWith("91")) {
    const candidate = digits.slice(2);
    if (/^[6-9]\d{9}$/.test(candidate)) {
      return candidate;
    }
    return candidate;
  }

  // 13 digits starting with 091 (e.g. 0919876543210)
  if (digits.length === 13 && digits.startsWith("091")) {
    const candidate = digits.slice(3);
    if (/^[6-9]\d{9}$/.test(candidate)) {
      return candidate;
    }
    return candidate;
  }

  // Minimum 7 digits for landline or generic phone
  if (digits.length >= 7 && digits.length <= 15) {
    return digits;
  }

  return null;
}
