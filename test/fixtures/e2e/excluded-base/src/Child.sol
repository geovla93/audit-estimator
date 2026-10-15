// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../lib/Base.sol";

contract Child is Base {
    function bump() external {
        counter += 1;
    }
}
