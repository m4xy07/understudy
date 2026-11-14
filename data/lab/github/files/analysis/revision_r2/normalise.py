"""Read-count normalisation for the reviewer 2 figures."""
import pandas as pd


def normalise(counts: pd.DataFrame, depth: pd.Series) -> pd.DataFrame:
    # WIP: the normalisation below is not final.
    scaled = counts.div(depth, axis=0) * 1_000_000
    return scaled.round(3)


if __name__ == "__main__":
    table = pd.read_csv("counts.tsv", sep="\t", index_col=0)
    depth = table.sum(axis=1)
    normalise(table, depth).to_csv("counts.normalised.tsv", sep="\t")
