import { createContext } from "react";

/** Marks the part of an editor whose button labels use the form text size. */
export const FormDensity = createContext<"form" | null>(null);
