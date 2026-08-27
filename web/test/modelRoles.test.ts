/**
 * Unit tests for model-role value composition: each role is edited as two
 * fields (model + thinking level) but stored as omp's single string value
 * `provider/model` or `provider/model:thinking`.
 */
import { describe, expect, test } from "bun:test";
import { ROLE_THINKING_LEVELS, joinRoleValue, parseRoleValue } from "../src/lib/modelRoles";

describe("parseRoleValue", () => {
	test("plain model value has no thinking suffix", () => {
		expect(parseRoleValue("openai/gpt-5")).toEqual({ model: "openai/gpt-5", thinking: "" });
	});

	test("splits a known thinking suffix off the model", () => {
		expect(parseRoleValue("openai/gpt-5:high")).toEqual({ model: "openai/gpt-5", thinking: "high" });
		expect(parseRoleValue("openrouter/openai/gpt-5:low")).toEqual({
			model: "openrouter/openai/gpt-5",
			thinking: "low",
		});
	});

	test("empty and unset values parse to empty parts", () => {
		expect(parseRoleValue("")).toEqual({ model: "", thinking: "" });
		expect(parseRoleValue(undefined)).toEqual({ model: "", thinking: "" });
	});

	test("unknown suffixes stay glued to the model (omp validates them)", () => {
		expect(parseRoleValue("prov/model:future")).toEqual({ model: "prov/model:future", thinking: "" });
		expect(parseRoleValue("prov/model:")).toEqual({ model: "prov/model", thinking: "" });
		expect(parseRoleValue(":high")).toEqual({ model: ":high", thinking: "" });
	});
});

describe("joinRoleValue", () => {
	test("composes model + thinking into omp's role syntax", () => {
		expect(joinRoleValue("openai/gpt-5", "")).toBe("openai/gpt-5");
		expect(joinRoleValue("openai/gpt-5", "high")).toBe("openai/gpt-5:high");
	});

	test("a thinking level without a model composes to nothing", () => {
		expect(joinRoleValue("", "high")).toBe("");
		expect(joinRoleValue("", "")).toBe("");
	});

	test("round-trips every stored shape", () => {
		for (const value of ["openai/gpt-5", "openai/gpt-5:high", "openrouter/openai/gpt-5:low", ""]) {
			const parsed = parseRoleValue(value);
			expect(joinRoleValue(parsed.model, parsed.thinking)).toBe(value);
		}
	});
});

describe("ROLE_THINKING_LEVELS", () => {
	test("offers the concrete levels omp accepts, no 'inherit' (empty = default)", () => {
		expect(ROLE_THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});
});
