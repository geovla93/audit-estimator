// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Dependency file: Lib.sol
library Lib {
    function twice(uint256 x) internal pure returns (uint256) {
        return x * 2;
    }
}

// Dependency file: Helper.sol
contract Helper {
    uint256 public stored;

    function put(uint256 v) external {
        if (v > 0) {
            stored = v;
        }
    }
}

// Root file: Token.sol
contract Token {
    uint256 public total;
    Helper public helper;

    function mint(uint256 v) external {
        total = Lib.twice(v);
        helper.put(v);
    }
}
