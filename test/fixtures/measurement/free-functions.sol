pragma solidity 0.8.37;
function double(uint256 value) pure returns (uint256) { return value * 2; }
contract FreeFunctionUser {
    function twice(uint256 value) external pure returns (uint256) { return double(value); }
}
