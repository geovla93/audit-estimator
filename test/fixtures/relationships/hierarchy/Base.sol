pragma solidity 0.8.37;

contract Parent {
    function inherited() internal virtual returns (uint256) {
        return 1;
    }

    function extra() internal pure returns (uint256) {
        return 2;
    }
}

contract SameName {}

contract DiamondBase {
    function shared() internal pure returns (uint256) {
        return 3;
    }
}

contract DiamondLeft is DiamondBase {
    function left() internal pure returns (uint256) {
        return 4;
    }
}

contract DiamondRight is DiamondBase {}

contract Diamond is DiamondLeft, DiamondRight {}

interface IBase {}

interface IDerived is IBase {}
