"""The page. Streamlit runs this file from top to bottom each time someone interacts with it."""

import streamlit as st

from app.about import ABOUT
from app.data import growth

st.set_page_config(page_title=ABOUT["name"])

st.title(ABOUT["name"])
if ABOUT["description"]:
    st.text(ABOUT["description"])
else:
    st.caption("Describe your app in src/app/about.json.")

st.subheader("Growth")
weeks = st.slider("Weeks", min_value=2, max_value=52, value=12, key="weeks")
rate = st.number_input("Weekly growth (%)", min_value=0.0, max_value=50.0, value=5.0, key="rate")
values = growth(weeks, rate)
st.line_chart(values)
st.metric("After the last week", f"{values[-1]:,.2f}")

st.subheader("Clicks")
if "clicks" not in st.session_state:
    st.session_state.clicks = 0
if st.button("Click me", key="click"):
    st.session_state.clicks += 1
st.write(f"Clicked {st.session_state.clicks} {'time' if st.session_state.clicks == 1 else 'times'}")
