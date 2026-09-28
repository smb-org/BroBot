import type { ModuleExternalFetchBudget } from "../modules/contract";

export const MAX_EXTERNAL_FETCHES_PER_INVOCATION = 3;

export const createModuleExternalFetchBudget = (): ModuleExternalFetchBudget => {
  let count = 0;
  return {
    claim: () => {
      if (count >= MAX_EXTERNAL_FETCHES_PER_INVOCATION) return false;
      count += 1;
      return true;
    },
  };
};
