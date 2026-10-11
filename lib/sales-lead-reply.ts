/** Encode the recipient too: query delimiters in a supplied address must stay data. */
export function salesLeadReplyHref(email: string): string {
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent('SkillCheck — odpowiedź na zgłoszenie')}`;
}
