pragma solidity ^0.8.20;

import "custom/Math.sol";

contract Token {
    function total(uint256 left, uint256 right) external pure returns (uint256) {
        return Math.add(left, right);
    }
}
