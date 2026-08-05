#![cfg_attr(not(feature = "export-abi"), no_main)]

#[cfg(feature = "export-abi")]
fn main() {
    ecotoken_registry::print_abi("MIT-OR-Apache-2.0", "pragma solidity ^0.8.23;");
}

#[cfg(not(feature = "export-abi"))]
#[allow(dead_code)]
fn main() {}
