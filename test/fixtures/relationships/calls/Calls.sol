pragma solidity 0.8.37;

interface IRemote {
    function ping(uint256 value) external returns (uint256);
}

library Helpers {
    function twice(uint256 value) internal pure returns (uint256) {
        return value * 2;
    }
}

library CallLib {
    function call(address target) internal pure returns (uint256) {
        return uint160(target);
    }
}

function freeAdd(uint256 a, uint256 b) pure returns (uint256) {
    return a + b;
}

contract Token {
    function transfer(address to, uint256 amount) external pure returns (bool) {
        return to != address(0) && amount > 0;
    }
}

contract Caller {
    IRemote remote;
    Token token;

    function overloaded(uint256 value) internal pure returns (uint256) {
        return value;
    }

    function overloaded(address value) internal pure returns (uint256) {
        return uint160(value);
    }

    function identity(uint256 value) internal pure returns (uint256) {
        return value;
    }

    function selfCall() internal pure returns (uint256) {
        return identity(1);
    }

    function repeatCall() internal pure returns (uint256) {
        return identity(identity(2));
    }

    function useFree() internal pure returns (uint256) {
        return freeAdd(1, 2);
    }

    function useLibrary() internal pure returns (uint256) {
        return Helpers.twice(2);
    }

    function viaInterface() external returns (uint256) {
        return remote.ping(1);
    }

    function viaThis() external view returns (uint256) {
        return this.visible();
    }

    function visible() external pure returns (uint256) {
        return 1;
    }

    function viaOverload() internal pure returns (uint256) {
        return overloaded(1);
    }

    function viaPointer(function(uint256) internal pure returns (uint256) fp) internal pure returns (uint256) {
        return fp(1);
    }

    function lowLevel(address target, bytes memory data, address payable receiver) internal {
        target.call(data);
        target.delegatecall(data);
        target.staticcall(data);
        receiver.transfer(1);
        receiver.send(1);
        (bool ok, ) = target.call{value: 1}(data);
        require(ok);
        keccak256(data);
    }

    function customTransfer(address to) external returns (bool) {
        return token.transfer(to, 1);
    }

    function customCall(address target) internal pure returns (uint256) {
        return CallLib.call(target);
    }
}
