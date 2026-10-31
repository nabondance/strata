/** Claude and Gemini counted through their APIs with test keys and a stubbed fetch, with no fallback. */
export function apiPlan(fetchImpl) {
  return {
    methods: {
      claude: [
        {
          kind: "anthropic",
          model: "claude-test-model",
          auth: "x-api-key",
          secret: "anthropic-test-key",
          credential: "ANTHROPIC_API_KEY",
        },
      ],
      gemini: [
        {
          kind: "gemini-api",
          model: "gemini-test-model",
          secret: "gemini-test-key",
          credential: "GEMINI_API_KEY or GOOGLE_API_KEY",
        },
      ],
    },
    ...(fetchImpl ? { fetchImpl } : {}),
  };
}
