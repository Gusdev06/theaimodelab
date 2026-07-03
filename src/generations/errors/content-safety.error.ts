/**
 * Thrown when Veo / Vertex AI blocks a generation due to content safety filters.
 *
 * Support codes mapping:
 * 58061214 / 17301594 — Child
 * 29310472 / 15236754 — Celebrity
 * 64151117 / 42237218 — Video safety violation
 * 62263041            — Dangerous content
 * 57734940 / 22137204 — Hate speech
 * 74803281 / 29578790 / 42876398 — Other safety
 * 89371032 / 49114662 / 63429089 / 72817394 / 60599140 — Prohibited content
 * 35561574 / 35561575 — Third-party content
 * 90789179 / 43188360 — Sexual content
 * 78610348            — Toxic
 * 61493863 / 56562880 — Violence
 * 32635315            — Vulgar
 */
export class ContentSafetyError extends Error {
  readonly supportCode?: string;

  constructor(message: string, supportCode?: string) {
    super(message);
    this.name = 'ContentSafetyError';
    this.supportCode = supportCode;
  }

  /** Known Vertex AI safety support codes */
  static readonly SAFETY_CODES = new Set([
    '58061214', '17301594', // Child
    '29310472', '15236754', // Celebrity
    '64151117', '42237218', // Video safety violation
    '62263041',             // Dangerous content
    '57734940', '22137204', // Hate speech
    '74803281', '29578790', '42876398', // Other
    '89371032', '49114662', '63429089', '72817394', '60599140', // Prohibited
    '35561574', '35561575', // Third-party
    '90789179', '43188360', // Sexual
    '78610348',             // Toxic
    '61493863', '56562880', // Violence
    '32635315',             // Vulgar
  ]);

  /** Patterns in error messages that indicate a safety filter was triggered */
  static readonly SAFETY_PATTERNS = [
    /violat.*polic/i,
    /couldn.*t be submitted/i,
    /diretrizes de uso/i,
    /safety.*filter/i,
    /safety.*checker/i,
    /content.*policy/i,
    /content[\s_-]*moderation/i,
    /responsible\s*ai/i,
    /blocked.*safety/i,
    /support.*code/i,
    /não pôde gerar/i,
    /flagged as sensitive/i,
    /flagged for/i,
    /sensitive.*content/i,
    /inappropriate.*content/i,
    /nsfw/i,
    /\bE005\b/,
  ];

  /**
   * Check if an error message indicates a content safety violation.
   * Returns a ContentSafetyError if it matches, or null otherwise.
   */
  static fromErrorMessage(message: string): ContentSafetyError | null {
    // Check for known support codes
    for (const code of ContentSafetyError.SAFETY_CODES) {
      if (message.includes(code)) {
        return new ContentSafetyError(message, code);
      }
    }

    // Check for known error patterns
    for (const pattern of ContentSafetyError.SAFETY_PATTERNS) {
      if (pattern.test(message)) {
        return new ContentSafetyError(message);
      }
    }

    return null;
  }
}
