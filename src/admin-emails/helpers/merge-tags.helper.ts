/**
 * Variáveis disponíveis nos templates de email broadcast.
 * Sintaxe: `{{name}}`, `{{firstName}}`, `{{email}}`, `{{plan}}`.
 *
 * Variáveis sem valor (ex: usuário sem nome cadastrado, free user sem plan)
 * são substituídas por string vazia (fallback B definido pelo product).
 */

const MERGE_TAG_REGEX = /\{\{(\w+)\}\}/g;

export interface MergeTagInput {
  name?: string | null;
  plan?: string | null;
  email: string;
}

export type MergeTagVars = Record<string, string>;

export function buildMergeVars(input: MergeTagInput): MergeTagVars {
  const fullName = (input.name ?? '').trim();
  const firstName = fullName.split(/\s+/)[0] ?? '';
  return {
    name: fullName,
    firstName,
    email: input.email,
    plan: (input.plan ?? '').trim(),
  };
}

export function applyMergeTags(text: string, vars: MergeTagVars): string {
  return text.replace(MERGE_TAG_REGEX, (_, key: string) => vars[key] ?? '');
}

export const AVAILABLE_MERGE_TAGS: Array<{ key: string; label: string; example: string }> = [
  { key: 'name', label: 'Nome completo', example: 'João Silva' },
  { key: 'firstName', label: 'Primeiro nome', example: 'João' },
  { key: 'email', label: 'Email', example: 'joao@example.com' },
  { key: 'plan', label: 'Plano atual', example: 'Pro' },
];
