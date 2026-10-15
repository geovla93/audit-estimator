// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../lib/Missing.sol";

contract Main {
    uint256 public value;

    function set(uint256 next) external {
        value = next;
    }
}
