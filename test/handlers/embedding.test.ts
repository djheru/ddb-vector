import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildEmbeddingText,
  EmbeddingValidationError,
  generateEmbedding,
} from "../../functions/shared/embedding";
import { embeddingResponse, setHandlerEnv, validRecipe } from "./helpers";

const bedrockMock = mockClient(BedrockRuntimeClient);

beforeEach(() => {
  bedrockMock.reset();
  setHandlerEnv();
});

describe("buildEmbeddingText", () => {
  it("contains name, description, cuisine, dietary, and ingredient names", () => {
    const text = buildEmbeddingText(validRecipe);
    expect(text).toContain("Spicy Chicken Stew");
    expect(text).toContain("A fiery, slow-simmered chicken stew with chipotle and tomatoes.");
    expect(text).toContain("Cuisine: mexican.");
    expect(text).toContain("Dietary: gluten-free.");
    expect(text).toContain("Ingredients: chicken thighs, chipotle peppers.");
  });

  it("has no prep or cook time sentence even when times are set", () => {
    const text = buildEmbeddingText(validRecipe);
    expect(text).not.toMatch(/prep/i);
    expect(text).not.toMatch(/cook time/i);
    expect(text).not.toMatch(/minute/i);
    expect(text).not.toContain("15");
    expect(text).not.toContain("45 minutes.");
  });

  it("omits the dietary sentence when no tags are present", () => {
    const text = buildEmbeddingText({ ...validRecipe, dietary: undefined });
    expect(text).not.toContain("Dietary:");
  });
});

describe("generateEmbedding", () => {
  it("requests the configured model with 1024 normalized dimensions and parses the embedding", async () => {
    bedrockMock.on(InvokeModelCommand).resolves(embeddingResponse([0.1, -0.2, 0.3]));

    const embedding = await generateEmbedding("some text");

    expect(embedding).toEqual([0.1, -0.2, 0.3]);
    const calls = bedrockMock.commandCalls(InvokeModelCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.modelId).toBe("amazon.titan-embed-text-v2:0");
    expect(JSON.parse(input.body as string)).toEqual({
      inputText: "some text",
      dimensions: 1024,
      normalize: true,
    });
  });

  it("maps Bedrock ValidationException to a typed EmbeddingValidationError", async () => {
    const validationError = new Error("Input is too long");
    validationError.name = "ValidationException";
    bedrockMock.on(InvokeModelCommand).rejects(validationError);

    await expect(generateEmbedding("way too long")).rejects.toBeInstanceOf(
      EmbeddingValidationError,
    );
  });

  it("rethrows non-validation errors untouched", async () => {
    const throttling = new Error("Rate exceeded");
    throttling.name = "ThrottlingException";
    bedrockMock.on(InvokeModelCommand).rejects(throttling);

    await expect(generateEmbedding("text")).rejects.toThrow("Rate exceeded");
  });
});
