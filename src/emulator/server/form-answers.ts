/**
 * Answer validation for member form submissions, mirroring Planeward
 * `validateFormAnswers` (`lib/validations/form-definition-schema.ts`):
 * answers are read by field slug (else id) and stored by field id.
 */

type Option = { value: string; label: string; reveals?: FormField };

export type FormField = {
  id: string;
  slug?: string;
  label: string;
  type: string;
  required?: boolean;
  options?: Option[];
};

export type FormDefinition = {
  sections: Array<{ id: string; title: string; fields: FormField[] }>;
};

export type FormAnswerValue = string | number | boolean | string[] | null;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ANSWER_MAX_LENGTH = 20_000;
/** Planeward's bot trap; an API caller never sets it. */
export const FORM_HONEYPOT_FIELD = "company_website";

const fieldSlug = (field: FormField) => field.slug?.trim() || field.id;

function rawForField(raw: Record<string, unknown>, field: FormField) {
  const slug = fieldSlug(field);
  return Object.hasOwn(raw, slug) ? raw[slug] : raw[field.id];
}

const asTrimmedString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

/** Answerable fields, plus fields revealed by a selected option. */
function visibleFields(
  definition: FormDefinition,
  raw: Record<string, unknown>
): FormField[] {
  const out: FormField[] = [];
  const visit = (field: FormField) => {
    if (field.type === "section") return;
    out.push(field);
    if (!field.options) return;
    const value = rawForField(raw, field);
    const selected = new Set(
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : typeof value === "string"
          ? [value.trim()]
          : []
    );
    for (const option of field.options) {
      if (option.reveals && selected.has(option.value)) visit(option.reveals);
    }
  };
  for (const section of definition.sections ?? []) {
    for (const field of section.fields) visit(field);
  }
  return out;
}

export function validateFormAnswers(
  definition: FormDefinition,
  rawAnswers: Record<string, unknown>
):
  | { ok: true; answers: Record<string, FormAnswerValue> }
  | { ok: false; error: string } {
  const raw = { ...rawAnswers };
  delete raw[FORM_HONEYPOT_FIELD];
  const answers: Record<string, FormAnswerValue> = {};

  for (const field of visibleFields(definition, raw)) {
    const value = rawForField(raw, field);
    const allowed = new Set(
      (field.options ?? []).map((option) => option.value)
    );

    if (field.type === "hidden") {
      answers[field.id] = asTrimmedString(value).slice(0, ANSWER_MAX_LENGTH);
      continue;
    }
    if (field.type === "boolean") {
      answers[field.id] = value === true || value === "true" || value === "on";
      continue;
    }
    if (field.type === "multi_select") {
      const values = Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : typeof value === "string" && value
          ? [value]
          : [];
      const selected = values.filter((item) => allowed.has(item));
      if (field.required && selected.length === 0) {
        return { ok: false, error: `${field.label} is required.` };
      }
      answers[field.id] = selected;
      continue;
    }
    if (field.type === "radio" || field.type === "select") {
      const text = asTrimmedString(value);
      if (field.required && !text) {
        return { ok: false, error: `${field.label} is required.` };
      }
      if (text && !allowed.has(text)) {
        return { ok: false, error: `${field.label} is invalid.` };
      }
      answers[field.id] = text;
      continue;
    }
    if (field.type === "number") {
      if (value === "" || value == null) {
        if (field.required) {
          return { ok: false, error: `${field.label} is required.` };
        }
        answers[field.id] = null;
        continue;
      }
      const number = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(number)) {
        return { ok: false, error: `${field.label} must be a number.` };
      }
      answers[field.id] = number;
      continue;
    }

    const text = asTrimmedString(value);
    if (field.required && !text) {
      return { ok: false, error: `${field.label} is required.` };
    }
    if (text.length > ANSWER_MAX_LENGTH) {
      return { ok: false, error: `${field.label} is too long.` };
    }
    if (field.type === "email" && text && !EMAIL_RE.test(text)) {
      return { ok: false, error: "Enter a valid email." };
    }
    answers[field.id] = text;
  }

  return { ok: true, answers };
}
