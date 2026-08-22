/**
 * PiAdapterShape — per-instance pi adapter contract. The driver bundles one
 * adapter per instance as a captured closure (see Drivers/PiDriver.ts); this
 * interface stays as the naming anchor for that bundle member.
 *
 * @module PiAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface PiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
