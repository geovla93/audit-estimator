pragma solidity ^0.8.20;

contract Vault {
    uint256 public value;
    function set(uint256 next) external {
        value = next;
    }
}
