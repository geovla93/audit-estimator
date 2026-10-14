pragma solidity ^0.8.20;
import "./relative.sol";
import * as Namespace from "./namespace.sol";
import {Remote as LocalRemote, Library} from "./named.sol";
error Denied(address caller);
interface ModernInterface { function read() external view returns (uint); }
contract Modern {
    string public constant MARKERS = "// not a comment; /* not trivia */";
    function control(uint x) external pure returns (uint y) {
        if (x > 0) { y = 1; }
        for (uint i = 0; i < x; i++) { y += 1; }
        while (y < 3) { y += 1; }
    }
    function assemblyValue() external pure returns (uint result) {
        assembly { result := add(1, 2) }
    }
}
