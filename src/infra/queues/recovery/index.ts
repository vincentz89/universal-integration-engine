import { registerRecoveryAdapter } from "./recovery-adapter-registry.js";
import { bigCommerceRecoveryAdapter } from "./adapters/bigcommerce-recovery.adapter.js";

// Register supported provider recovery adapters.
registerRecoveryAdapter(bigCommerceRecoveryAdapter);