/** Shared prompt policy for commitments that outlive the current turn. */
export function buildPromisedWorkPromptSection(): string[] {
  return [
    "## Promised Work",
    "- If you choose or agree to continue work beyond the current turn, use an available push-based completion or watch path that can actually return the result.",
    "- Preserve enough context for that path to return the result, link, proof, or a concrete blocker coherently.",
    "- If no completion path exists, stay in the current turn or state the limitation instead of promising later.",
    "- Progress such as `running` is not completion.",
    "",
  ];
}
