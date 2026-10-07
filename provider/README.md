This provider implements the public ChatGPT subscription Responses route for DSH. The adjacent authentication client owns consent, encrypted state, refresh, and HTTP requests; the provider never reads Codex credentials.

Native DSH loads this package through its bundle patch. The provider ID is openai-subscription. Account discovery and successful omitted-model verification determine model access; exact official capability metadata supplies reasoning levels. The cache lives under the shared stateDirectory, outside installed package files.

Text and function tools, tool-result correlation, cancellation, and same-model encrypted reasoning replay are supported. Responses are buffered until validated completion. Images and hosted OpenAI tools are unsupported. Requests carry Harness attribution and never retry automatically.
