export interface TranslationTextDiagnostics {
    missingPlaceholders: string[];
    extraPlaceholders: string[];
    uncoveredCharacters: string[];
    characterCoverageChecked: boolean;
    placeholderSyntax: 'simple-braces';
    runtimeVerified: false;
}

/** Only {identifier} placeholders; no ICU, printf, font shaping or layout inference. */
export function auditTranslationText(base: string, translated: string, supportedCharacters?: string): TranslationTextDiagnostics {
    const placeholders = (value: string): Set<string> => new Set(Array.from(value.matchAll(/(?<!\{)\{([A-Za-z_][A-Za-z0-9_.-]{0,63})\}(?!\})/g), match => match[1]));
    const expected = placeholders(base);
    const actual = placeholders(translated);
    const supported = supportedCharacters === undefined ? undefined : new Set(supportedCharacters);
    const uncovered = new Set<string>();
    if (supported) {
        const visible = translated.replace(/(?<!\{)\{([A-Za-z_][A-Za-z0-9_.-]{0,63})\}(?!\})/g, '');
        for (const character of visible) if (!/\s/u.test(character) && !supported.has(character)) uncovered.add(character);
    }
    return {
        missingPlaceholders: [...expected].filter(name => !actual.has(name)).sort(),
        extraPlaceholders: [...actual].filter(name => !expected.has(name)).sort(),
        uncoveredCharacters: [...uncovered].sort(), characterCoverageChecked: supported !== undefined,
        placeholderSyntax: 'simple-braces', runtimeVerified: false,
    };
}
