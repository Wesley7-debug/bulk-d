import { DiscoveredFile } from "../types";
import { resourceValidator } from "./resource-validator";

interface ValidationResult {
  downloadable: boolean;
  reason?: string;
}

class ValidatorEngine {
  async validateResource(file: DiscoveredFile): Promise<ValidationResult> {
    const result = await resourceValidator.validateResource(file);
    return {
      downloadable: result.downloadable,
      reason: result.reason,
    };
  }
}

export const validators = new ValidatorEngine();
