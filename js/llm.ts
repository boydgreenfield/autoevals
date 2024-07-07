import * as yaml from "js-yaml";
import mustache from "mustache";

import { Score, Scorer, ScorerArgs } from "@braintrust/core";
import { ChatCache, OpenAIAuth, cachedChatCompletion } from "./oai";
import { templates } from "./templates";
import {
  ChatCompletionCreateParams,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from "openai/resources";
import { makePartial, ScorerWithPartial } from "./partial";

const NO_COT_SUFFIX =
  "Answer the question by calling `select_choice` with a single choice from {{__choices}}.";

const COT_SUFFIX =
  "Answer the question by calling `select_choice` with your reasoning in a step-by-step manner to be sure that your conclusion is correct. Avoid simply stating the correct answer at the outset. Select a single choice by setting the `choice` parameter to a single choice from {{__choices}}.";

const SUPPORTED_MODELS = ["gpt-3.5-turbo", "gpt-4"];

export type LLMArgs = {
  maxTokens?: number;
  temperature?: number;
} & OpenAIAuth;

const PLAIN_RESPONSE_SCHEMA = {
  properties: {
    choice: { description: "The choice", title: "Choice", type: "string" },
  },
  required: ["choice"],
  title: "FunctionResponse",
  type: "object",
};

const COT_RESPONSE_SCHEMA = {
  properties: {
    reasons: {
      description:
        "Write out in a step by step manner your reasoning to be sure that your conclusion is correct. Avoid simply stating the correct answer at the outset.",
      items: { type: "string" },
      title: "Reasons",
      type: "array",
    },
    choice: { description: "The choice", title: "Choice", type: "string" },
  },
  required: ["reasons", "choice"],
  title: "CoTResponse",
  type: "object",
};

export function buildClassificationFunctions(
  useCoT: boolean,
  choiceStrings: string[]
) {
  const params = useCoT ? COT_RESPONSE_SCHEMA : PLAIN_RESPONSE_SCHEMA;
  const enumParams = {
    ...params,
    properties: {
      ...params.properties,
      choice: { ...params.properties.choice, enum: choiceStrings },
    },
  };
  return [
    {
      name: "select_choice",
      description: "Call this function to select a choice.",
      parameters: enumParams,
    },
  ];
}

export type OpenAIClassifierArgs<RenderArgs> = {
  name: string;
  model: string;
  messages: ChatCompletionMessageParam[];
  choiceScores: Record<string, number>;
  classificationFunctions: ChatCompletionCreateParams.Function[];
  cache?: ChatCache;
} & LLMArgs &
  RenderArgs;

export async function OpenAIClassifier<RenderArgs, Output>(
  args: ScorerArgs<Output, OpenAIClassifierArgs<RenderArgs>>
): Promise<Score> {
  const {
    name,
    output,
    expected,
    openAiApiKey,
    openAiOrganizationId,
    openAiBaseUrl,
    openAiDefaultHeaders,
    openAiDangerouslyAllowBrowser,
    ...remaining
  } = args;

  const {
    messages: messagesArg,
    model,
    choiceScores,
    classificationFunctions,
    maxTokens,
    temperature,
    cache,
    ...remainingRenderArgs
  } = remaining;

  let found = false;
  for (const m of SUPPORTED_MODELS) {
    if (model.startsWith(m)) {
      found = true;
      break;
    }
  }
  if (!found) {
    throw new Error(
      `Unsupported model: ${model}. Currently only supports OpenAI chat models.`
    );
  }

  const extraArgs = {
    temperature: temperature || 0,
    max_tokens: maxTokens,
  };

  const renderArgs = {
    output,
    expected,
    ...remainingRenderArgs,
  };

  const messages: ChatCompletionMessageParam[] = messagesArg.map((m) => ({
    ...m,
    content: m.content ? mustache.render(m.content as string, renderArgs) : "",
  }));

  const resp = await cachedChatCompletion(
    {
      model,
      messages,
      functions: classificationFunctions,
      function_call: { name: "select_choice" },
      ...extraArgs,
    },
    {
      cache,
      openAiApiKey,
      openAiOrganizationId,
      openAiBaseUrl,
      openAiDefaultHeaders,
      openAiDangerouslyAllowBrowser,
    }
  );

  if (resp.choices.length > 0) {
    return {
      name,
      ...parseResponse(resp.choices[0].message!, choiceScores),
    };
  } else {
    throw new Error("Empty response from OpenAI");
  }
}

function parseResponse(
  resp: ChatCompletionMessage,
  choiceScores: Record<string, number>
): Omit<Score, "name"> {
  let score = 0;
  const metadata: Record<string, unknown> = {};
  const args = JSON.parse(resp.function_call!.arguments!);
  metadata["rationale"] = args["reasons"]?.join("\n");
  const choice = args["choice"].trim();
  metadata["choice"] = choice;
  if (choiceScores[choice] !== undefined) {
    score = choiceScores[choice];
  } else {
    throw new Error(`Unknown score choice ${choice}`);
  }
  return {
    score,
    metadata,
  };
}

export type LLMClassifierArgs<RenderArgs> = {
  model?: string;
  useCoT?: boolean;
} & LLMArgs &
  RenderArgs;

export function LLMClassifierFromTemplate<RenderArgs>({
  name,
  promptTemplate,
  choiceScores,
  model = "gpt-3.5-turbo",
  useCoT: useCoTArg,
  temperature,
}: {
  name: string;
  promptTemplate: string;
  choiceScores: Record<string, number>;
  model?: string;
  useCoT?: boolean;
  temperature?: number;
}): Scorer<string, LLMClassifierArgs<RenderArgs>> {
  const choiceStrings = Object.keys(choiceScores);
  const ret = async (
    runtimeArgs: ScorerArgs<string, LLMClassifierArgs<RenderArgs>>
  ) => {
    const useCoT = runtimeArgs.useCoT ?? useCoTArg ?? true;

    const prompt =
      promptTemplate + "\n" + (useCoT ? COT_SUFFIX : NO_COT_SUFFIX);

    let maxTokens = 512;
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "user",
        content: prompt,
      },
    ];

    return await OpenAIClassifier({
      name,
      messages,
      choiceScores,
      classificationFunctions: buildClassificationFunctions(
        useCoT,
        choiceStrings
      ),
      model,
      maxTokens,
      temperature,
      __choices: choiceStrings,
      ...runtimeArgs,

      // Since the logic is a bit funky for computing this, include
      // it at the end to prevent overrides
      useCoT,
    });
  };
  Object.defineProperty(ret, "name", {
    value: name,
    configurable: true,
  });

  return ret;
}

export interface ModelGradedSpec {
  prompt: string;
  choice_scores: Record<string, number>;
  model?: string;
  use_cot?: boolean;
  temperature?: number;
}

export function LLMClassifierFromSpec<RenderArgs>(
  name: string,
  spec: ModelGradedSpec
): Scorer<any, LLMClassifierArgs<RenderArgs>> {
  return LLMClassifierFromTemplate({
    name,
    promptTemplate: spec.prompt,
    choiceScores: spec.choice_scores,
    model: spec.model,
    useCoT: spec.use_cot,
    temperature: spec.temperature,
  });
}

export function LLMClassifierFromSpecFile<RenderArgs>(
  name: string,
  templateName: keyof typeof templates
): Scorer<any, LLMClassifierArgs<RenderArgs>> {
  const doc = yaml.load(templates[templateName]) as ModelGradedSpec;
  return LLMClassifierFromSpec(name, doc);
}

function buildLLMClassifier<RenderArgs>(
  name: string,
  templateName: keyof typeof templates
): ScorerWithPartial<string, LLMClassifierArgs<RenderArgs>> {
  if (!(templateName in templates)) {
    throw new Error(`Model template ${name} not found`);
  }

  return makePartial(
    LLMClassifierFromSpecFile<RenderArgs>(
      name,
      templateName as keyof typeof templates
    ),
    name
  );
}

/**
 * Test whether an output _better_ performs the `instructions` than the original
 * (expected) value.
 */
export const Battle = buildLLMClassifier<{ instructions: string }>(
  "Battle",
  "battle"
);

/**
 * Test whether an output answers the `input` using knowledge built into the model.
 * You can specify `criteria` to further constrain the answer.
 */
export const ClosedQA = buildLLMClassifier<{ input: string; criteria: any }>(
  "ClosedQA",
  "closed_q_a"
);

/**
 * Test whether an output is funny.
 */
export const Humor = buildLLMClassifier<{}>("Humor", "humor");

/**
 * Test whether an output is factual, compared to an original (`expected`) value.
 */
export const Factuality = buildLLMClassifier<{
  input: string;
  output: string;
  expected?: string;
}>("Factuality", "factuality");

/**
 * Test whether an output is a possible solution to the challenge posed in the input.
 */
export const Possible = buildLLMClassifier<{ input: string }>(
  "Possible",
  "possible"
);

/**
 * Test whether an output is malicious.
 */
export const Security = buildLLMClassifier<{}>("Security", "security");

/**
 * Test whether a SQL query is semantically the same as a reference (output) query.
 */
export const Sql = buildLLMClassifier<{ input: string }>("Sql", "sql");

/**
 * Test whether an output is a better summary of the `input` than the original (`expected`) value.
 */
export const Summary = buildLLMClassifier<{ input: string }>(
  "Summary",
  "summary"
);

/**
 * Test whether an `output` is as good of a translation of the `input` in the specified `language`
 * as an expert (`expected`) value.
 */
export const Translation = buildLLMClassifier<{
  language: string;
  input: string;
}>("Translation", "translation");
