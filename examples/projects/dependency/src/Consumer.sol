pragma solidity ^0.8.20;

import "vendor/Math.sol";

contract Consumer {
    function sum(uint256 left, uint256 right) external pure returns (uint256) {
        return Math.add(left, right);
    }
}
