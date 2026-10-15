// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IRemote {
    function ping(uint256 value) external returns (uint256);
}

struct Position {
    uint256 amount;
}

contract Token {
    function transfer(address to, uint256 amount) external returns (bool) {
        return to != address(0) && amount > 0;
    }
}

contract Vault {
    mapping(address => uint256) public balances;
    uint256[] public queue;
    uint256 public constant LIMIT = 10;
    Position internal position;
    IRemote public remote;
    Token public token;

    modifier onlyOwner() {
        _;
    }

    function initialize() external onlyOwner {
        assembly {
            for { let i := 0 } lt(i, 4) { i := add(i, 1) } { }
        }
    }

    function drain(address target, bytes calldata data) external onlyOwner {
        for (uint256 i = 0; i < queue.length; i++) {
            balances[target] += 1;
        }
        (bool ok, ) = target.delegatecall(data);
        require(ok);
        token.transfer(target, 1);
        remote.ping(1);
    }
}
