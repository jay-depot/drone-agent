import type {
  LspSignatureHelpResponse,
  LspSignatureInformation,
  NormalizedSignatureHelp,
} from './types.js';
import { normalizeMarkupContent } from './helpers.js';

export function normalizeSignatureHelp(
  response: LspSignatureHelpResponse | null | undefined
): NormalizedSignatureHelp {
  const signatures = response?.signatures ?? [];
  const activeSignature = response?.activeSignature ?? 0;
  const fallbackActiveParameter = response?.activeParameter ?? 0;
  return {
    activeSignature,
    activeParameter: fallbackActiveParameter,
    signatures: signatures
      .filter(
        (signature): signature is LspSignatureInformation =>
          typeof signature === 'object' && signature !== null
      )
      .map(signature => {
        const activeParameter =
          signature.activeParameter ?? fallbackActiveParameter;
        return {
          label: signature.label ?? '',
          documentation: normalizeMarkupContent(signature.documentation),
          parameters: (signature.parameters ?? []).map(parameter => {
            let labelText = '';
            if (typeof parameter.label === 'string') {
              labelText = parameter.label;
            } else if (
              Array.isArray(parameter.label) &&
              parameter.label.length === 2 &&
              typeof signature.label === 'string'
            ) {
              const [start, end] = parameter.label;
              labelText = signature.label.slice(start, end);
            }
            return {
              label: labelText,
              documentation: normalizeMarkupContent(parameter.documentation),
            };
          }),
          activeParameter,
        };
      }),
  };
}
