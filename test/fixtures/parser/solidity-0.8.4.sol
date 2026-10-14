pragma solidity 0.8.4;
error Unauthorized(address caller);
interface EightInterface { function read() external view returns (uint); }
contract Eight {
    function read() external pure returns (uint result) {
        assembly { result := add(1, 2) }
    }
}
