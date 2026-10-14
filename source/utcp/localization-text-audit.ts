export type TranslationPlaceholderSyntax = 'simple-braces' | 'i18next';
export interface TranslationTextDiagnostics {
    missingPlaceholders: string[];
    extraPlaceholders: string[];
    uncoveredCharacters: string[];
    characterCoverageChecked: boolean;
    placeholderSyntax: TranslationPlaceholderSyntax;
    syntaxSupported: boolean;
    runtimeVerified: false;
}

/** Selected identifier syntax only; no ICU, nesting, formatter evaluation or layout inference. */
export function auditTranslationText(base: string, translated: string, supportedCharacters?: string, syntax: TranslationPlaceholderSyntax = 'simple-braces'): TranslationTextDiagnostics {
    const pattern = syntax === 'i18next' ? /(?<!\{)\{\{\s*-?\s*([A-Za-z_][A-Za-z0-9_.-]{0,63})\s*(?:,[^{}]*)?\}\}(?!\})/g : /(?<!\{)\{([A-Za-z_][A-Za-z0-9_.-]{0,63})\}(?!\})/g;
    const placeholders = (value: string): Set<string> => new Set(Array.from(value.matchAll(pattern), match => match[1]));
    const expected = placeholders(base);
    const actual = placeholders(translated);
    const unsupported = (value: string) => syntax === 'i18next' && /\{\{|\}\}/.test(value.replace(pattern, ''));
    const syntaxSupported = !unsupported(base) && !unsupported(translated);
    const supported = supportedCharacters === undefined ? undefined : new Set(supportedCharacters);
    const uncovered = new Set<string>();
    if (supported) {
        const visible = translated.replace(pattern, '');
        for (const character of visible) if (!/\s/u.test(character) && !supported.has(character)) uncovered.add(character);
    }
    return {
        missingPlaceholders: [...expected].filter(name => !actual.has(name)).sort(),
        extraPlaceholders: [...actual].filter(name => !expected.has(name)).sort(),
        uncoveredCharacters: [...uncovered].sort(), characterCoverageChecked: supported !== undefined,
        placeholderSyntax: syntax, syntaxSupported, runtimeVerified: false,
    };
}
