import { ChatCompletionCreateParams } from "openai/resources/index";
import { ChatMessage, CompletionOptions, LLMOptions } from "../../index.js";
import { toChatBody } from "../openaiTypeConverters.js";

import OpenAI from "./OpenAI.js";

class Cerebras extends OpenAI {
  static providerName = "cerebras";
  static defaultOptions: Partial<LLMOptions> = {
    apiBase: "https://api.cerebras.ai/v1/",
  };
  maxStopWords: number | undefined = 4;

  constructor(options: LLMOptions) {
    // Override context length before calling super() to ensure it's set correctly
    const modifiedOptions = { ...options };

    // Set context length based on the specific model
    if (options.model === "qwen-3-coder-480b-free") {
      modifiedOptions.contextLength = 64000;
      modifiedOptions.model = "qwen-3-coder-480b";
    } else if (options.model === "qwen-3-coder-480b") {
      modifiedOptions.contextLength = 128000;
    }

    super(modifiedOptions);
    
    // CRITICAL FIX: Force Cerebras to use _streamChat path by ensuring templateMessages is undefined
    // This bypasses the OpenAI adapter path where tool calls get lost
    this.templateMessages = undefined;
  }

  private filterThinkingTags(content: string): string {
    // Remove <thinking>...</thinking> tags (including multiline)
    return content.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
  }

  private filterThinkingFromMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((message) => {
      if (typeof message.content === "string") {
        return {
          ...message,
          content: this.filterThinkingTags(message.content),
        } as ChatMessage;
      } else if (Array.isArray(message.content)) {
        return {
          ...message,
          content: message.content.map((part) => {
            if (part.type === "text" && typeof part.text === "string") {
              return {
                ...part,
                text: this.filterThinkingTags(part.text),
              };
            }
            return part;
          }),
        } as ChatMessage;
      }
      return message;
    });
  }

  protected _convertArgs(
    options: CompletionOptions,
    messages: ChatMessage[],
  ): ChatCompletionCreateParams {
    // Filter thinking tags from messages before processing
    const filteredMessages = this.filterThinkingFromMessages(messages);
    // Create the base parameters using the OpenAI converter
    const params = toChatBody(filteredMessages, options);
    
    // Ensure tools are properly formatted for Cerebras
    if (options.tools && options.tools.length > 0) {
      params.tools = options.tools.map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        },
      }));
      
      // Set tool_choice to auto to encourage tool usage
      params.tool_choice = "auto";
    }
    
    // Convert model name
    params.model = this._convertModelName(params.model);
    
    return params;
  }

  private static modelConversion: { [key: string]: string } = {
    "qwen-3-coder-480b-free": "qwen-3-coder-480b", // Maps free version to base model
    "qwen-3-coder-480b": "qwen-3-coder-480b",
    "qwen-3-235b-a22b-instruct-2507": "qwen-3-235b-a22b-instruct-2507",
    "llama-3.3-70b": "llama-3.3-70b",
    "qwen-3-32b": "qwen-3-32b",
    "qwen-3-235b-a22b-thinking-2507": "qwen-3-235b-a22b-thinking-2507",
    "gpt-oss-120b": "gpt-oss-120b",
  };
  protected _convertModelName(model: string): string {
    return Cerebras.modelConversion[model] ?? model;
  }

  protected async *_streamChat(
    messages: ChatMessage[],
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<ChatMessage> {
    // FIX: Accumulate tool calls properly like WatsonX does
    let accumulatedToolCalls: any[] = [];
    let accumulatedContent = "";
    let hasSeenToolCall = false;
    
    for await (const message of super._streamChat(messages, signal, options)) {
      const toolCalls = (message as any).toolCalls;
      
      if (toolCalls && toolCalls.length > 0) {
        // We're seeing tool calls - accumulate them
        hasSeenToolCall = true;
        
        // Filter out incomplete tool calls (missing critical fields)
        const validToolCalls = toolCalls.filter((tc: any) => 
          tc.id && tc.type && tc.function?.name
        );
        
        if (validToolCalls.length > 0) {
          accumulatedToolCalls.push(...validToolCalls);
        }
        
        // Save any content that came with this chunk
        if (message.content) {
          accumulatedContent += typeof message.content === 'string' ? message.content : '';
        }
        
        // Don't yield yet - continue accumulating
        continue;
      } else if (!hasSeenToolCall) {
        // Regular message without tool calls - yield normally
        yield message;
      } else {
        // We've seen tool calls before, but this chunk has none
        // Just accumulate any content
        if (message.content) {
          accumulatedContent += typeof message.content === 'string' ? message.content : '';
        }
      }
    }
    
    // Stream is done - if we accumulated tool calls, yield them now as ONE message
    if (accumulatedToolCalls.length > 0) {
      // Deduplicate tool calls by ID (in case of duplicates)
      const uniqueToolCalls = Array.from(
        new Map(accumulatedToolCalls.map(tc => [tc.id, tc])).values()
      );
      
      yield {
        role: "assistant",
        content: accumulatedContent || "",
        toolCalls: uniqueToolCalls
      } as any;
    } else if (hasSeenToolCall && accumulatedContent) {
      // We saw tool calls but they were all invalid, still yield the content
      yield {
        role: "assistant",
        content: accumulatedContent
      };
    }
  }
}

export default Cerebras;
